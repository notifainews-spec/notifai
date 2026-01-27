require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

// ===== CONFIGURATION =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const NOTIFAI_API_URL = process.env.NOTIFAI_API_URL || 'https://notifainews1.onrender.com';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 60000; // 1 minute default

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Track posted articles to avoid duplicates
const postedArticles = new Set();
let lastCheckedTimestamp = {};

// Available regions in NotifAi API
const REGIONS = ['us', 'cn', 'pk', 'id', 'uk', 'ng'];

// Categories returned by API (lanes)
// API returns: { categories: { us, entertainment, finance, world, crypto } }
// "us" = politics for region, others are global or region-specific
const CATEGORY_INFO = {
  us: { emoji: '🇺🇸', zh: '美国政治', en: 'US Politics' },
  cn: { emoji: '🇨🇳', zh: '中国政治', en: 'China Politics' },
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

// Fetch articles from NotifAi API
// API: GET /api/articles?region=cn returns { categories: { cn, entertainment, finance, world, crypto } }
async function fetchFromNotifAi(region = 'cn') {
  try {
    const response = await axios.get(`${NOTIFAI_API_URL}/api/articles`, {
      params: { region: region },
      timeout: 15000
    });
    
    const data = response.data;
    
    // API returns { site, region, categories: { us/cn/etc, entertainment, finance, world, crypto } }
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
async function getArticlesForCategory(category, region = 'cn', limit = 10) {
  const categories = await fetchFromNotifAi(region);
  
  // Map category names
  // 'world' and 'crypto' are global
  // 'politics' maps to the region name (e.g., 'cn' for China politics)
  // 'finance' and 'entertainment' are region-specific
  
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
    // For region-specific politics (cn, us, pk, etc.)
    articles = categories[category] || categories[region] || [];
  } else {
    // Default: try to get from categories directly
    articles = categories[category] || [];
  }
  
  return Array.isArray(articles) ? articles.slice(0, limit) : [];
}

// Fetch latest news with timestamp filter (for real-time)
async function fetchLatestNews(category, region = 'cn', sinceTimestamp = null) {
  try {
    const articles = await getArticlesForCategory(category, region, 20);
    
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
  
  // Map NotifAi's field names
  const title = article.title || '无标题';
  const summary = article.summary || article.description || '';
  const displaySummary = summary.length > 280 
    ? summary.substring(0, 280) + '...' 
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
${catInfo.emoji} <b>${catInfo.zh} | ${catInfo.en}</b>

📌 <b>${escapeHtml(title)}</b>

${escapeHtml(displaySummary)}

📍 来源: ${escapeHtml(source)}
${timeStr}
🔗 <a href="${url}">阅读全文 Read More</a>

━━━━━━━━━━━━━━━
💎 <b>NotifAi</b> - 阅读新闻赚取代币
📱 https://play.google.com/store/apps/details?id=com.notifai
━━━━━━━━━━━━━━━
`;
  
  return { message: message.trim(), imageUrl };
}

// ===== POSTING FUNCTIONS =====

async function postToChannel(article, categoryKey, isBreaking = false) {
  // Create unique ID for deduplication
  const articleId = article.id || article.url || article.title;
  
  if (postedArticles.has(articleId)) {
    console.log(`⏭️ Skipping duplicate: ${article.title?.substring(0, 50)}...`);
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
        console.log(`⚠️ Image failed, sending text only`);
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
    
    // Mark as posted
    postedArticles.add(articleId);
    
    // Keep set manageable (max 2000 articles)
    if (postedArticles.size > 2000) {
      const arr = Array.from(postedArticles);
      arr.splice(0, 1000);
      postedArticles.clear();
      arr.forEach(id => postedArticles.add(id));
    }
    
    console.log(`✅ Posted: ${article.title?.substring(0, 50)}...`);
    return true;
    
  } catch (error) {
    console.error(`❌ Error posting to channel:`, error.message);
    return false;
  }
}

// ===== REAL-TIME NEWS MONITORING =====

async function checkForNewArticles() {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking for new articles...`);
  
  for (const category of REALTIME_CATEGORIES) {
    try {
      const since = lastCheckedTimestamp[category] || Date.now() - (5 * 60 * 1000); // Default: last 5 mins
      
      // Use 'cn' region for China-focused bot
      const articles = await fetchLatestNews(category, 'cn', since);
      
      if (articles.length > 0) {
        console.log(`📰 Found ${articles.length} new ${category} articles`);
        
        // Post newest articles (max 3 per check to avoid spam)
        const toPost = articles.slice(0, 3);
        
        for (const article of toPost) {
          await postToChannel(article, category, false);
          // Rate limit: 2 seconds between posts
          await sleep(2000);
        }
      } else {
        console.log(`📭 No new ${category} articles`);
      }
      
      // Update timestamp
      lastCheckedTimestamp[category] = Date.now();
      
    } catch (error) {
      console.error(`❌ Error checking ${category}:`, error.message);
    }
    
    // Small delay between categories
    await sleep(1000);
  }
}

// ===== SCHEDULED BROADCASTS =====

async function broadcastCategory(category, region = 'cn', limit = 3) {
  console.log(`📡 Broadcasting ${category} news...`);
  
  const articles = await getArticlesForCategory(category, region, limit);
  
  if (articles.length === 0) {
    console.log(`⚠️ No articles found for ${category}`);
    return 0;
  }
  
  let posted = 0;
  for (const article of articles.slice(0, limit)) {
    if (await postToChannel(article, category)) {
      posted++;
      await sleep(3000); // 3 second delay between posts
    }
  }
  
  console.log(`✅ Posted ${posted}/${limit} ${category} articles`);
  return posted;
}

async function dailyDigest() {
  console.log(`\n📰 Sending daily digest...`);
  
  const digestMessage = `
🌅 <b>NotifAi 每日新闻摘要</b>
<b>Daily News Digest</b>

━━━━━━━━━━━━━━━

今日为您精选以下新闻:
`;
  
  await bot.sendMessage(CHANNEL_ID, digestMessage, { parse_mode: 'HTML' });
  await sleep(1000);
  
  // Post top story from each priority category
  for (const category of REALTIME_CATEGORIES) {
    await broadcastCategory(category, 'cn', 2);
    await sleep(5000);
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
        { text: '📱 下载 NotifAi App', url: 'https://play.google.com/store/apps/details?id=com.notifai' }
      ]
    ]
  };
  
  const welcomeMessage = `
🎉 <b>欢迎使用 NotifAi 新闻机器人!</b>
Welcome to NotifAi News Bot!

📰 实时获取中国、加密货币及国际新闻
🔔 自动推送最新资讯到频道
💎 下载 NotifAi App 阅读新闻赚取代币

<b>命令 Commands:</b>
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

// Callback query handler for inline buttons
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
  
  // Get mix of cn, crypto, world
  for (const category of ['cn', 'crypto', 'world']) {
    const articles = await getArticlesForCategory(category, 'cn', 1);
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
<b>📋 新闻分类 News Categories</b>

<b>🔴 实时更新 Real-time:</b>
🇨🇳 /china - 中国新闻
🪙 /crypto - 加密货币
🌍 /world - 国际新闻

<b>📰 其他分类 Other:</b>
💼 /finance - 财经
🎬 /entertainment - 娱乐
🇺🇸 /us - 美国新闻
`;
  
  await bot.sendMessage(chatId, catList, { parse_mode: 'HTML' });
});

// /status command (admin)
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const status = `
🤖 <b>Bot Status</b>

📊 Articles tracked: ${postedArticles.size}
🔄 Poll interval: ${POLL_INTERVAL/1000}s
📡 API: ${NOTIFAI_API_URL}
📢 Channel: ${CHANNEL_ID}

<b>Last checked:</b>
${Object.entries(lastCheckedTimestamp).map(([k,v]) => `• ${k}: ${new Date(v).toLocaleTimeString()}`).join('\n') || '• Not yet checked'}
`;
  await bot.sendMessage(chatId, status, { parse_mode: 'HTML' });
});

// Helper function to send category news
async function sendCategoryNews(chatId, category) {
  const catInfo = CATEGORY_INFO[category] || { zh: category, en: category };
  
  await bot.sendMessage(chatId, `⏳ 正在获取${catInfo.zh}...`);
  
  // Determine region based on category
  const region = REGIONS.includes(category) ? category : 'cn';
  const articles = await getArticlesForCategory(category, region, 5);
  
  if (articles.length === 0) {
    await bot.sendMessage(chatId, `❌ 暂无${catInfo.zh}，请稍后再试\nNo ${catInfo.en} news available`);
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

// ===== SCHEDULED TASKS =====

// Real-time monitoring: Check every minute
setInterval(checkForNewArticles, POLL_INTERVAL);

// Scheduled broadcasts (Beijing timezone)
// Morning digest at 8:00 AM
cron.schedule('0 8 * * *', dailyDigest, { timezone: 'Asia/Shanghai' });

// Midday update at 12:30 PM
cron.schedule('30 12 * * *', () => {
  broadcastCategory('cn', 'cn', 2);
  setTimeout(() => broadcastCategory('crypto', 'cn', 2), 10000);
}, { timezone: 'Asia/Shanghai' });

// Evening update at 6:00 PM
cron.schedule('0 18 * * *', () => {
  broadcastCategory('world', 'cn', 2);
  setTimeout(() => broadcastCategory('finance', 'cn', 2), 10000);
}, { timezone: 'Asia/Shanghai' });

// Night crypto update at 10:00 PM
cron.schedule('0 22 * * *', () => broadcastCategory('crypto', 'cn', 3), { timezone: 'Asia/Shanghai' });

// ===== STARTUP =====

async function startup() {
  console.log('═══════════════════════════════════════');
  console.log('🚀 NotifAi Telegram Bot Starting...');
  console.log('═══════════════════════════════════════');
  console.log(`📡 API: ${NOTIFAI_API_URL}`);
  console.log(`📢 Channel: ${CHANNEL_ID}`);
  console.log(`🔄 Poll Interval: ${POLL_INTERVAL/1000} seconds`);
  console.log(`🔴 Real-time categories: ${REALTIME_CATEGORIES.join(', ')}`);
  console.log('═══════════════════════════════════════');
  
  // Initialize timestamps
  const now = Date.now();
  for (const cat of REALTIME_CATEGORIES) {
    lastCheckedTimestamp[cat] = now;
  }
  
  // Send startup message to channel
  try {
    await bot.sendMessage(CHANNEL_ID, `
🤖 <b>NotifAi 新闻机器人已上线!</b>
Bot is now online!

🔴 <b>实时更新 Real-time Updates:</b>
• 🇨🇳 中国新闻 China News
• 🪙 加密货币 Crypto
• 🌍 国际新闻 World News

📰 新闻将自动推送到此频道
News will be posted automatically

💎 下载 NotifAi App 赚取代币:
https://play.google.com/store/apps/details?id=com.notifai
`, { parse_mode: 'HTML' });
    
    console.log('✅ Startup message sent to channel');
  } catch (error) {
    console.error('⚠️ Could not send startup message:', error.message);
    console.error('Make sure bot is admin in channel with posting permissions');
  }
  
  // Do initial check after 10 seconds
  setTimeout(checkForNewArticles, 10000);
  
  console.log('✅ Bot is running and monitoring for news...\n');
}

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Start the bot
startup();
