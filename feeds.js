// feeds.js — with new Crypto category

export const CATEGORIES = [
  { key: "us",           label: "US" },
  { key: "world",        label: "World" },
  { key: "entertainment",label: "Entertainment" },
  { key: "finance",      label: "Finance" },
  { key: "crypto",       label: "Crypto" }  // <-- NEW
];

export const FEEDS = {
  us: [
    "https://www.theguardian.com/us-news/rss",
    "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml"
  ],
  world: [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.theguardian.com/world/rss"
  ],
  entertainment: [
    "https://www.rollingstone.com/feed/",
    "https://variety.com/feed/"
  ],
  finance: [
    "https://www.theguardian.com/us/business/rss",
    "https://techcrunch.com/feed/"
  ],
  // NEW — Crypto sources (feel free to trim/add)
  crypto: [
    "https://cointelegraph.com/rss",
    "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml",
    "https://decrypt.co/feed"
  ]
};
