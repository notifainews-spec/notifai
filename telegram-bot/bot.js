require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ===== CONFIGURATION =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const NOTIFAI_API_URL = process.env.NOTIFAI_API_URL || 'https://notifainews1.onrender.com';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 60000; // 1 minute default
const LANGUAGE = process.env.LANGUAGE || 'zh-CN'; // Chinese by default

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Track posted articles to avoid duplicates
const postedArticles = new Set();
let lastCheckedTimestamp = {};

// Available regions in NotifAi API
const REGIONS = ['us', 'cn', 'pk', 'id', 'uk', 'ng'];

// Categories returned by API
const CATEGORY_INFO = {
  us: { emoji: '🇺🇸', zh: '美国政治', en: 'US Politics' },
  cn: { emoji: '🇨🇳', zh: '中国新闻', en: 'China News' },
  pk: { emoji: '🇵🇰', zh: '巴基斯坦', en: 'Pakistan' },
  ng: { emoji: '🇳🇬', zh: '尼日利亚', en: 'Nigeria' },
  uk: { emoji: '🇬🇧', zh: '英国', en: 'UK' },
  id: { emoji: '🇮🇩', zh: '印尼', en: 'Indonesia' },
  world: { emoji: '🌍', zh: '国际新闻', en: 'World' },
  crypto: { emoji: '🪙', zh: '加密货币', en: 'Crypto' },
  finance: { emoji: '💼', zh: '财经', en: 'Finance' },
  entertainment: { emoji: '🎬', zh: '娱乐', en: 'Entertainment' }
};

// Categories to monitor for real-time (China users focus)
const REALTIME_CATEGORIES = ['world', 'crypto', 'cn'];

// ===== NOTIFAI API FUNCTIONS =====

// Fetch articles from NotifAi API with Chinese translation
async function fetchFromNotifAi(region = 'cn', lang = LANGUAGE) {
  try {
    const response = await axios.get(`${NOTIFAI_API_URL}/api/articles`, {
      params: { 
        region: region,
        lang: lang  // Request Chinese translation from API
      },
      timeout: 20000
    });
    
    const data = response.data;
    
    if (data.categories) {
      return data.categories;
    }
    
    return {};
  } catch (error) {
    console.error(`❌ Error fetching from NotifAi:`, error.message);
    return {};
  }
}

// Get articles for a specific category/lane
async function getArticlesForCategory(category, region = 'cn', limit = 10, lang = LANGUAGE) {
  const categories = await fetchFromNotifAi(region, lang);
  
  let articles = [];
  
  if (category === 'world') {
    articles = categories.world || [];
  } else if (category === 'crypto') {
    articles = categories.crypto || [];
  } else if (category === 'finance') {
    articles = categories.finance || [];
  } else if (category === 'entertainment') {
    articles = categories.entertainment || [];
  } else if (REGIONS.includes(category)) {
    articles = categories[category] || categories[region] || [];
  } else {
    articles = categories[category] || [];
  }
  
  return Array.isArray(articles) ? articles.slice(0, limit) : [];
}

// Fetch latest news with timestamp filter (for real-time)
async function fetchLatestNews(category, region = 'cn', sinceTimestamp = null, lang = LANGUAGE) {
  try {
    const articles = await getArticlesForCategory(category, region, 20, lang);
    
    if (!sinceTimestamp || articles.length === 0) {
      return articles;
    }
    
    // Filter by timestamp - only return new articles
    return articles.filter(article => {
      const articleTime = new Date(article.publishedAt || article.createdAt).getTime();
      return articleTime > sinceTimestamp;
    });
  } catch (error) {
    console.error(`❌ Error fetching latest ${category}:`, error.message);
    return [];
  }
}

// ===== MESSAGE FORMATTING =====

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatArticle(article, categoryKey) {
  const catInfo = CATEGORY_INFO[categoryKey] || CATEGORY_INFO.world;
  
  const title = article.title || '无标题';
  const summary = article.summary || article.description || '';
  const displaySummary = summary.length > 300 
    ? summary.substring(0, 300) + '...' 
    : summary;
  const source = article.source || '未知来源';
  const url = article.url;
  const imageUrl = article.image || article.urlToImage;
  
  // Format publish time (Beijing timezone)
  let timeStr = '';
  if (article.publishedAt || article.createdAt) {
    const pubDate = new Date(article.publishedAt || article.createdAt);
    timeStr = `🕐 ${pubDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }
  
  const message = `
${catInfo.emoji} <b>${catInfo.zh}</b>

📌 <b>${escapeHtml(title)}</b>

${escapeHtml(displaySummary)}

📍 来源: ${escapeHtml(source)}
${timeStr}
🔗 <a href="${url}">阅读全文</a>

━━━━━━━━━━━━━━━
💎 <b>NotifAi</b> - 阅读新闻赚取代币
📱 https://linktr.ee/notifainews
━━━━━━━━━━━━━━━
`;
  
  return { message: message.trim(), imageUrl };
}

// ===== POSTING FUNCTIONS =====

async function postToChannel(article, categoryKey) {
  const articleId = article.id || article.url || article.title;
  
  if (postedArticles.has(articleId)) {
    console.log(`⏭️ 跳过重复: ${article.title?.substring(0, 40)}...`);
    return false;
  }
  
  const { message, imageUrl } = formatArticle(article, categoryKey);
  
  try {
    if (imageUrl) {
      try {
        await bot.sendPhoto(CHANNEL_ID, imageUrl, {
          caption: message,
          parse_mode: 'HTML'
        });
      } catch (imgError) {
        console.log(`⚠️ 图片失败，发送纯文本`);
        await bot.sendMessage(CHANNEL_ID, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false
        });
      }
    } else {
      await bot.sendMessage(CHANNEL_ID, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: false
      });
    }
    
    postedArticles.add(articleId);
    
    // Keep set manageable
    if (postedArticles.size > 2000) {
      const arr = Array.from(postedArticles);
      arr.splice(0, 1000);
      postedArticles.clear();
      arr.forEach(id => postedArticles.add(id));
    }
    
    console.log(`✅ 已发布: ${article.title?.substring(0, 40)}...`);
    return true;
    
  } catch (error) {
    console.error(`❌ 发布失败:`, error.message);
    return false;
  }
}

// ===== REAL-TIME NEWS MONITORING =====

async function checkForNewArticles() {
  console.log(`\n🔍 [${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] 检查新文章...`);
  
  for (const category of REALTIME_CATEGORIES) {
    try {
      const since = lastCheckedTimestamp[category] || Date.now() - (5 * 60 * 1000);
      
      // Fetch with Chinese translation
      const articles = await fetchLatestNews(category, 'cn', since, LANGUAGE);
      
      if (articles.length > 0) {
        console.log(`📰 发现 ${articles.length} 篇新 ${CATEGORY_INFO[category]?.zh || category} 文章`);
        
        // Post ALL new articles immediately
        for (const article of articles) {
          await postToChannel(article, category);
          // Rate limit: 2 seconds between posts
          await sleep(2000);
        }
      } else {
        console.log(`📭 无新 ${CATEGORY_INFO[category]?.zh || category} 文章`);
      }
      
      // Update timestamp
      lastCheckedTimestamp[category] = Date.now();
      
    } catch (error) {
      console.error(`❌ 检查 ${category} 失败:`, error.message);
    }
    
    await sleep(1000);
  }
}

// ===== BOT COMMANDS =====

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🇨🇳 中国新闻', callback_data: 'news_cn' },
        { text: '🪙 加密货币', callback_data: 'news_crypto' }
      ],
      [
        { text: '🌍 国际新闻', callback_data: 'news_world' },
        { text: '💼 财经', callback_data: 'news_finance' }
      ],
      [
        { text: '🎬 娱乐', callback_data: 'news_entertainment' },
        { text: '🇺🇸 美国', callback_data: 'news_us' }
      ],
      [
        { text: '📱 下载 NotifAi App', url: 'https://linktr.ee/notifainews' }
      ]
    ]
  };
  
  const welcomeMessage = `
🎉 <b>欢迎使用 NotifAi 新闻机器人!</b>

📰 实时推送中国、加密货币及国际新闻
🇨🇳 所有内容自动翻译成中文
💎 下载 NotifAi App 阅读新闻赚取代币

<b>命令:</b>
/news - 最新新闻
/china - 中国新闻
/crypto - 加密货币
/world - 国际新闻
/finance - 财经新闻
/categories - 所有分类

点击下方按钮获取新闻 👇
`;

  await bot.sendMessage(chatId, welcomeMessage, { 
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

// Callback query handler
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  if (data.startsWith('news_')) {
    const category = data.replace('news_', '');
    const catInfo = CATEGORY_INFO[category] || { zh: category };
    await bot.answerCallbackQuery(query.id, { text: `正在获取${catInfo.zh}...` });
    await sendCategoryNews(chatId, category);
  }
});

// Generic news command
bot.onText(/\/news$/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ 正在获取最新新闻...');
  
  for (const category of ['cn', 'crypto', 'world']) {
    const articles = await getArticlesForCategory(category, 'cn', 1, LANGUAGE);
    if (articles.length > 0) {
      const { message, imageUrl } = formatArticle(articles[0], category);
      try {
        if (imageUrl) {
          await bot.sendPhoto(chatId, imageUrl, { caption: message, parse_mode: 'HTML' });
        } else {
          await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
      } catch (e) {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      }
      await sleep(1000);
    }
  }
});

// Category-specific commands
bot.onText(/\/china/, async (msg) => await sendCategoryNews(msg.chat.id, 'cn'));
bot.onText(/\/cn/, async (msg) => await sendCategoryNews(msg.chat.id, 'cn'));
bot.onText(/\/crypto/, async (msg) => await sendCategoryNews(msg.chat.id, 'crypto'));
bot.onText(/\/world/, async (msg) => await sendCategoryNews(msg.chat.id, 'world'));
bot.onText(/\/us/, async (msg) => await sendCategoryNews(msg.chat.id, 'us'));
bot.onText(/\/finance/, async (msg) => await sendCategoryNews(msg.chat.id, 'finance'));
bot.onText(/\/entertainment/, async (msg) => await sendCategoryNews(msg.chat.id, 'entertainment'));

// /categories command
bot.onText(/\/categories/, async (msg) => {
  const chatId = msg.chat.id;
  
  const catList = `
<b>📋 新闻分类</b>

<b>🔴 实时更新:</b>
🇨🇳 /china - 中国新闻
🪙 /crypto - 加密货币
🌍 /world - 国际新闻

<b>📰 其他分类:</b>
💼 /finance - 财经
🎬 /entertainment - 娱乐
🇺🇸 /us - 美国新闻
`;
  
  await bot.sendMessage(chatId, catList, { parse_mode: 'HTML' });
});

// /status command
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const status = `
🤖 <b>机器人状态</b>

📊 已追踪文章: ${postedArticles.size}
🔄 检查间隔: ${POLL_INTERVAL/1000}秒
🌐 语言: ${LANGUAGE}
📡 API: ${NOTIFAI_API_URL}
📢 频道: ${CHANNEL_ID}

<b>上次检查:</b>
${Object.entries(lastCheckedTimestamp).map(([k,v]) => `• ${CATEGORY_INFO[k]?.zh || k}: ${new Date(v).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}`).join('\n') || '• 尚未检查'}
`;
  await bot.sendMessage(chatId, status, { parse_mode: 'HTML' });
});

// Helper function to send category news
async function sendCategoryNews(chatId, category) {
  const catInfo = CATEGORY_INFO[category] || { zh: category, en: category };
  
  await bot.sendMessage(chatId, `⏳ 正在获取${catInfo.zh}...`);
  
  const region = REGIONS.includes(category) ? category : 'cn';
  const articles = await getArticlesForCategory(category, region, 5, LANGUAGE);
  
  if (articles.length === 0) {
    await bot.sendMessage(chatId, `❌ 暂无${catInfo.zh}，请稍后再试`);
    return;
  }
  
  for (const article of articles.slice(0, 3)) {
    const { message, imageUrl } = formatArticle(article, category);
    try {
      if (imageUrl) {
        await bot.sendPhoto(chatId, imageUrl, { caption: message, parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      }
    } catch (e) {
      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    }
    await sleep(1500);
  }
}

// ===== UTILITY =====

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== REAL-TIME ONLY - NO SCHEDULED BROADCASTS =====

// Check for new articles every minute
setInterval(checkForNewArticles, POLL_INTERVAL);

// ===== STARTUP =====

async function startup() {
  console.log('═══════════════════════════════════════');
  console.log('🚀 NotifAi 电报机器人启动中...');
  console.log('═══════════════════════════════════════');
  console.log(`📡 API: ${NOTIFAI_API_URL}`);
  console.log(`📢 频道: ${CHANNEL_ID}`);
  console.log(`🔄 检查间隔: ${POLL_INTERVAL/1000} 秒`);
  console.log(`🌐 语言: ${LANGUAGE}`);
  console.log(`🔴 实时分类: ${REALTIME_CATEGORIES.map(c => CATEGORY_INFO[c]?.zh || c).join(', ')}`);
  console.log('═══════════════════════════════════════');
  
  // Initialize timestamps
  const now = Date.now();
  for (const cat of REALTIME_CATEGORIES) {
    lastCheckedTimestamp[cat] = now;
  }
  
  // Send startup message
  try {
    await bot.sendMessage(CHANNEL_ID, `
🤖 <b>NotifAi 新闻机器人已上线!</b>

🔴 <b>实时更新分类:</b>
• 🇨🇳 中国新闻
• 🪙 加密货币
• 🌍 国际新闻

📰 新文章将立即推送到此频道
🇨🇳 所有内容自动翻译成中文

💎 下载 NotifAi App 赚取代币:
https://linktr.ee/notifainews
`, { parse_mode: 'HTML' });
    
    console.log('✅ 启动消息已发送到频道');
  } catch (error) {
    console.error('⚠️ 无法发送启动消息:', error.message);
  }
  
  // Initial check after 10 seconds
  setTimeout(checkForNewArticles, 10000);
  
  console.log('✅ 机器人正在运行，监控新闻中...\n');
}

// Error handling
bot.on('polling_error', (error) => {
  console.error('轮询错误:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('未捕获异常:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('未处理拒绝:', error);
});

// Start the bot
startup();
