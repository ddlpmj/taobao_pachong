document.addEventListener('DOMContentLoaded', () => {
  const keywordInput = document.getElementById('keyword');
  const searchBtn = document.getElementById('searchBtn');
  const exportBtn = document.getElementById('exportBtn');
  const statusArea = document.getElementById('statusArea');
  const platformSelect = document.getElementById('platformSelect');

  let scrapedData = [];
  let currentPlatform = 'taobao'; // Default platform

  // Update platform selection handler
  platformSelect.addEventListener('change', (e) => {
    currentPlatform = e.target.value;
    // Load data for selected platform
    loadPlatformData();
  });

  // Load data for current platform
  function loadPlatformData() {
    const dataKey = currentPlatform === 'jd' ? 'jdData' : 'taobaoData';
    chrome.storage.local.get([dataKey], (result) => {
      if (result[dataKey] && result[dataKey].length > 0) {
        scrapedData = result[dataKey];
        const platformName = currentPlatform === 'jd' ? '京东' : '淘宝';
        statusArea.textContent = `上次爬取(${platformName})：${scrapedData.length} 个商品 (已准备好导出)`;
        exportBtn.disabled = false;
      } else {
        scrapedData = [];
        statusArea.textContent = '等待操作...';
        exportBtn.disabled = true;
      }
    });
  }

  // Initial load
  loadPlatformData();

  searchBtn.addEventListener('click', async () => {
    const keyword = keywordInput.value.trim();
    const pageLimit = parseInt(document.getElementById('pageLimit').value) || 1;
    const minDelay = parseInt(document.getElementById('minDelay').value) || 3;
    const maxDelay = parseInt(document.getElementById('maxDelay').value) || 5;
    currentPlatform = platformSelect.value;

    if (!keyword) {
      statusArea.textContent = '请输入关键词';
      return;
    }

    statusArea.textContent = '正在打开搜索页...';

    // Determine data key and URL based on platform
    const dataKey = currentPlatform === 'jd' ? 'jdData' : 'taobaoData';
    let searchUrl;
    
    if (currentPlatform === 'jd') {
      // JD search URL - desktop: search.jd.com, mobile: so.m.jd.com
      // Use desktop version for better compatibility
      searchUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}`;
    } else {
      // Taobao search URL
      searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;
    }

    // Save settings to storage for content script to use
    await chrome.storage.local.set({
      'targetKeyword': keyword,
      'pageLimit': pageLimit,
      'minDelay': minDelay,
      'maxDelay': maxDelay,
      'currentPage': 1,
      'lastScrapedId': null, // Reset signature
      [dataKey]: [] // Clear previous data for new search
    });

    // Open new tab with search query
    const tab = await chrome.tabs.create({ url: searchUrl, active: true });

    const platformName = currentPlatform === 'jd' ? '京东' : '淘宝';
    statusArea.textContent = `请在新标签页加载完成后，点击页面上的"开始爬取"按钮...`;
  });

  // Listen for messages from content script (real-time updates)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'dataScraped') {
      // Determine platform from message or use current selection
      const platform = request.platform || currentPlatform;
      if (platform === currentPlatform) {
        scrapedData = request.data;
        const platformName = platform === 'jd' ? '京东' : '淘宝';
        statusArea.textContent = `成功获取(${platformName}) ${scrapedData.length} 个商品！`;
        exportBtn.disabled = false;
      }
    } else if (request.action === 'statusUpdate') {
      statusArea.textContent = request.message;
    }
  });

  exportBtn.addEventListener('click', () => {
    if (scrapedData.length === 0) return;

    // Helper to extract ID based on platform
    function getItemId(url, platform) {
      try {
        if (platform === 'jd') {
          // JD URLs: https://item.jd.com/123456.html or https://item.m.jd.com/product/123456.html
          const match = url.match(/\/\d+\.html/);
          if (match) {
            return match[0].replace(/[\/\.html]/g, '');
          }
          const productMatch = url.match(/\/product\/(\d+)/);
          if (productMatch) {
            return productMatch[1];
          }
          return null;
        } else {
          // Taobao/Tmall URLs
          const urlObj = new URL(url);
          return urlObj.searchParams.get('id');
        }
      } catch (e) {
        return null;
      }
    }

    // Final Deduplication before Export
    const uniqueData = [];
    const seenIds = new Set();
    const seenLinks = new Set();

    scrapedData.forEach(item => {
      const id = getItemId(item.link, currentPlatform);
      if (id) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          uniqueData.push(item);
        }
      } else {
        // Fallback to link if no ID
        if (!seenLinks.has(item.link)) {
          seenLinks.add(item.link);
          uniqueData.push(item);
        }
      }
    });

    console.log(`Exporting ${uniqueData.length} unique items (filtered from ${scrapedData.length} total).`);

    // Determine if this is JD data (has sales/rating) or Taobao data
    const hasSalesRating = uniqueData.length > 0 && (uniqueData[0].sales !== undefined || uniqueData[0].rating !== undefined);
    
    let csvContent;
    if (hasSalesRating) {
      // JD format with sales and rating
      csvContent = "data:text/csv;charset=utf-8,\uFEFF"
        + "标题,价格,店铺,销量,好评率,链接\n"
        + uniqueData.map(e => {
          const title = `"${e.title.replace(/"/g, '""')}"`;
          const price = `"${e.price || 'N/A'}"`;
          const shop = `"${(e.shop || 'N/A').replace(/"/g, '""')}"`;
          const sales = `"${e.sales || 'N/A'}"`;
          const rating = `"${e.rating || 'N/A'}"`;
          const link = `"${e.link}"`;
          return `${title},${price},${shop},${sales},${rating},${link}`;
        }).join("\n");
    } else {
      // Taobao format (original)
      csvContent = "data:text/csv;charset=utf-8,\uFEFF"
        + "标题,价格,店铺,链接\n"
        + uniqueData.map(e => {
          const title = `"${e.title.replace(/"/g, '""')}"`;
          const price = `"${e.price}"`;
          const shop = `"${e.shop.replace(/"/g, '""')}"`;
          const link = `"${e.link}"`;
          return `${title},${price},${shop},${link}`;
        }).join("\n");
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const platformName = currentPlatform === 'jd' ? 'jd' : 'taobao';
    link.setAttribute("download", `${platformName}_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
});
