require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

// ===== CONFIGURATION =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const NOTIFAI_API_URL = process.env.NOTIFAI_API_URL || 'https://notifai-news.onrender.com';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 60000; // 1 minute default

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Track posted articles to avoid duplicates (persisted in memory)
const postedArticles = new Set();
let lastCheckedTimestamp = {};

// News categories with Chinese labels
const CATEGORIES = {
  china: { emoji: '🇨🇳', zh: '中国新闻', en: 'China', apiCategory: 'china' },
  crypto: { emoji: '🪙', zh: '加密货币', en: 'Crypto', apiCategory: 'crypto' },
  world: { emoji: '🌍', zh: '国际新闻', en: 'World', apiCategory: 'world' },
  business: { emoji: '💼', zh: '商业财经', en: 'Business', apiCategory: 'business' },
  technology: { emoji: '💻', zh: '科技', en: 'Technology', apiCategory: 'technology' },
  entertainment: { emoji: '🎬', zh: '娱乐', en: 'Entertainment', apiCategory: 'entertainment' },
  sports: { emoji: '⚽', zh: '体育', en: 'Sports', apiCategory: 'sports' },
  health: { emoji: '🏥', zh: '健康', en: 'Health', apiCategory: 'health' },
  science: { emoji: '🔬', zh: '科学', en: 'Science', apiCategory: 'science' }
};

// Priority categories for real-time updates
const REALTIME_CATEGORIES = ['china', 'crypto', 'world'];

// ===== NOTIFAI API FUNCTIONS =====

// Fetch news from NotifAi backend
async function fetchFromNotifAi(category, language = 'zh', limit = 10) {
  try {
    const response = await axios.get(`${NOTIFAI_API_URL}/api/news`, {
      params: {
        category: category,
        language: language,
        limit: limit
      },
      timeout: 10000
    });
    
    return response.data.articles || response.data || [];
  } catch (error) {
    console.error(`❌ Error fetching ${category} from NotifAi:`, error.message);
    return [];
  }
}

// Fetch latest news with timestamp filter (for real-time)
async function fetchLatestNews(category, sinceTimestamp = null) {
  try {
    const params = {
      category: category,
      language: 'zh',
      limit: 20,
      sortBy: 'publishedAt'
    };
    
    if (sinceTimestamp) {
      params.since = sinceTimestamp;
    }
    
    const response = await axios.get(`${NOTIFAI_API_URL}/api/news`, {
      params,
      timeout: 10000
    });
    
    let articles = response.data.articles || response.data || [];
    
    // Filter by timestamp if API doesn't support 'since' parameter
    if (sinceTimestamp && articles.length > 0) {
      articles = articles.filter(article => {
        const articleTime = new Date(article.publishedAt || article.createdAt).getTime();
        return articleTime > sinceTimestamp;
      });
    }
    
    return articles;
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
  const cat = CATEGORIES[categoryKey] || CATEGORIES.world;
  const title = article.title || '无标题';
  const description = article.description || article.summary || article.content
    ? (article.description || article.summary || article.content).substring(0, 250) + 
      ((article.description || article.summary || article.content).length > 250 ? '...' : '')
    : '点击查看详情';
  const source = article.source?.name || article.sourceName || article.source || '未知来源';
  const url = article.url || article.link;
  const imageUrl = article.urlToImage || article.imageUrl || article.image || article.thumbnail;
  
  // Format publish time
  let timeStr = '';
  if (article.publishedAt || article.createdAt) {
    const pubDate = new Date(article.publishedAt || article.createdAt);
    timeStr = `🕐 ${pubDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  }
  
  const message = `
${cat.emoji} <b>${cat.zh} | ${cat.en}</b>

📌 <b>${escapeHtml(title)}</b>

${escapeHtml(description)}

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

// Format breaking news (more prominent)
function formatBreakingNews(article, categoryKey) {
  const cat = CATEGORIES[categoryKey] || CATEGORIES.world;
  const title = article.title || '无标题';
  const description = article.description || article.summary || '';
  const source = article.source?.name || article.sourceName || article.source || '未知来源';
  const url = article.url || article.link;
  const imageUrl = article.urlToImage || article.imageUrl || article.image;
  
  const message = `
🚨🚨🚨 <b>突发新闻 BREAKING</b> 🚨🚨🚨

${cat.emoji} <b>${cat.zh}</b>

📌 <b>${escapeHtml(title)}</b>

${escapeHtml(description.substring(0, 300))}${description.length > 300 ? '...' : ''}

📍 ${escapeHtml(source)}
🔗 <a href="${url}">阅读全文</a>

━━━━━━━━━━━━━━━
💎 <b>NotifAi</b> - 下载App获取更多新闻
📱 https://play.google.com/store/apps/details?id=com.notifai
━━━━━━━━━━━━━━━
`;
  
  return { message: message.trim(), imageUrl };
}

// ===== POSTING FUNCTIONS =====

async function postToChannel(article, categoryKey, isBreaking = false) {
  // Create unique ID for deduplication
  const articleId = article.url || article.link || article.title || JSON.stringify(article).substring(0, 100);
  
  if (postedArticles.has(articleId)) {
    console.log(`⏭️ Skipping duplicate: ${article.title?.substring(0, 50)}...`);
    return false;
  }
  
  const { message, imageUrl } = isBreaking 
    ? formatBreakingNews(article, categoryKey)
    : formatArticle(article, categoryKey);
  
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
      const articles = await fetchLatestNews(category, since);
      
      if (articles.length > 0) {
        console.log(`📰 Found ${articles.length} new ${category} articles`);
        
        // Post newest articles (max 3 per check to avoid spam)
        const toPost = articles.slice(0, 3);
        
        for (const article of toPost) {
          await postToChannel(article, category, false);
          // Rate limit: 2 seconds between posts
          await sleep(2000);
        }
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

async function broadcastCategory(category, limit = 3) {
  console.log(`📡 Broadcasting ${category} news...`);
  
  const articles = await fetchFromNotifAi(category, 'zh', limit);
  
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
    await broadcastCategory(category, 2);
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
        { text: '🇨🇳 中国新闻', callback_data: 'news_china' },
        { text: '🪙 加密货币', callback_data: 'news_crypto' }
      ],
      [
        { text: '🌍 国际新闻', callback_data: 'news_world' },
        { text: '💼 商业财经', callback_data: 'news_business' }
      ],
      [
        { text: '💻 科技', callback_data: 'news_technology' },
        { text: '⚽ 体育', callback_data: 'news_sports' }
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
    await bot.answerCallbackQuery(query.id, { text: `正在获取${CATEGORIES[category]?.zh || category}...` });
    await sendCategoryNews(chatId, category);
  }
});

// Generic news command
bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '⏳ 正在获取最新新闻...');
  
  // Get mix of china, crypto, world
  for (const cat of ['china', 'crypto', 'world']) {
    const articles = await fetchFromNotifAi(cat, 'zh', 1);
    if (articles.length > 0) {
      const { message, imageUrl } = formatArticle(articles[0], cat);
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
bot.onText(/\/china/, async (msg) => await sendCategoryNews(msg.chat.id, 'china'));
bot.onText(/\/crypto/, async (msg) => await sendCategoryNews(msg.chat.id, 'crypto'));
bot.onText(/\/world/, async (msg) => await sendCategoryNews(msg.chat.id, 'world'));
bot.onText(/\/business/, async (msg) => await sendCategoryNews(msg.chat.id, 'business'));
bot.onText(/\/tech(nology)?/, async (msg) => await sendCategoryNews(msg.chat.id, 'technology'));
bot.onText(/\/sports/, async (msg) => await sendCategoryNews(msg.chat.id, 'sports'));
bot.onText(/\/health/, async (msg) => await sendCategoryNews(msg.chat.id, 'health'));
bot.onText(/\/science/, async (msg) => await sendCategoryNews(msg.chat.id, 'science'));
bot.onText(/\/entertainment/, async (msg) => await sendCategoryNews(msg.chat.id, 'entertainment'));

// /categories command
bot.onText(/\/categories/, async (msg) => {
  const chatId = msg.chat.id;
  
  let catList = `<b>📋 新闻分类 News Categories</b>\n\n`;
  catList += `<b>🔴 实时更新 Real-time:</b>\n`;
  for (const key of REALTIME_CATEGORIES) {
    const cat = CATEGORIES[key];
    catList += `${cat.emoji} /${key} - ${cat.zh}\n`;
  }
  catList += `\n<b>📰 其他分类 Other:</b>\n`;
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (!REALTIME_CATEGORIES.includes(key)) {
      catList += `${cat.emoji} /${key} - ${cat.zh}\n`;
    }
  }
  
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
${Object.entries(lastCheckedTimestamp).map(([k,v]) => `• ${k}: ${new Date(v).toLocaleTimeString()}`).join('\n')}
`;
  await bot.sendMessage(chatId, status, { parse_mode: 'HTML' });
});

// Helper function to send category news
async function sendCategoryNews(chatId, category) {
  const cat = CATEGORIES[category];
  if (!cat) {
    await bot.sendMessage(chatId, '❌ 未知分类');
    return;
  }
  
  await bot.sendMessage(chatId, `⏳ 正在获取${cat.zh}...`);
  
  const articles = await fetchFromNotifAi(category, 'zh', 5);
  
  if (articles.length === 0) {
    await bot.sendMessage(chatId, `❌ 暂无${cat.zh}，请稍后再试`);
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
  broadcastCategory('china', 2);
  setTimeout(() => broadcastCategory('crypto', 2), 10000);
}, { timezone: 'Asia/Shanghai' });

// Evening update at 6:00 PM
cron.schedule('0 18 * * *', () => {
  broadcastCategory('world', 2);
  setTimeout(() => broadcastCategory('business', 2), 10000);
}, { timezone: 'Asia/Shanghai' });

// Night crypto update at 10:00 PM
cron.schedule('0 22 * * *', () => broadcastCategory('crypto', 3), { timezone: 'Asia/Shanghai' });

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
