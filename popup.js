document.addEventListener('DOMContentLoaded', () => {
  const keywordInput = document.getElementById('keyword');
  const searchBtn = document.getElementById('searchBtn');
  const exportBtn = document.getElementById('exportBtn');
  const statusArea = document.getElementById('statusArea');

  let scrapedData = [];

  searchBtn.addEventListener('click', async () => {
    const keyword = keywordInput.value.trim();
    const pageLimit = parseInt(document.getElementById('pageLimit').value) || 1;
    const minDelay = parseInt(document.getElementById('minDelay').value) || 3;
    const maxDelay = parseInt(document.getElementById('maxDelay').value) || 5;

    if (!keyword) {
      statusArea.textContent = '请输入关键词';
      return;
    }

    statusArea.textContent = '正在打开搜索页...';

    // Save settings to storage for content script to use
    await chrome.storage.local.set({
      'targetKeyword': keyword,
      'pageLimit': pageLimit,
      'minDelay': minDelay,
      'maxDelay': maxDelay,
      'currentPage': 1,
      'lastScrapedId': null, // Reset signature
      'taobaoData': [] // Clear previous data for new search
    });

    // Open new tab with search query
    const url = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;
    const tab = await chrome.tabs.create({ url: url, active: true });

    // Wait for tab to load (basic wait, then inject script)
    // Note: Content script is automatically injected by manifest, 
    // but we need to trigger the scrape action.

    // We'll use a listener to wait for the content script to be ready
    // or just wait a bit and send a message.

    statusArea.textContent = '请在新标签页加载完成后，再次点击此插件...';
    // Ideally, we would automate this, but for simplicity in V1:
    // We can inject a script that auto-runs.
  });

  // Load saved data from storage
  chrome.storage.local.get(['taobaoData'], (result) => {
    if (result.taobaoData && result.taobaoData.length > 0) {
      scrapedData = result.taobaoData;
      statusArea.textContent = `上次爬取：${scrapedData.length} 个商品 (已准备好导出)`;
      exportBtn.disabled = false;
    }
  });

  // Listen for messages from content script (real-time updates)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'dataScraped') {
      scrapedData = request.data;
      statusArea.textContent = `成功获取 ${scrapedData.length} 个商品！`;
      exportBtn.disabled = false;
    } else if (request.action === 'statusUpdate') {
      statusArea.textContent = request.message;
    }
  });

  exportBtn.addEventListener('click', () => {
    if (scrapedData.length === 0) return;

    // Helper to extract ID
    function getItemId(url) {
      try {
        const urlObj = new URL(url);
        return urlObj.searchParams.get('id');
      } catch (e) {
        return null;
      }
    }

    // Final Deduplication before Export
    const uniqueData = [];
    const seenIds = new Set();
    const seenLinks = new Set();

    scrapedData.forEach(item => {
      const id = getItemId(item.link);
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

    const csvContent = "data:text/csv;charset=utf-8,\uFEFF"
      + "标题,价格,店铺,链接\n"
      + uniqueData.map(e => {
        const title = `"${e.title.replace(/"/g, '""')}"`;
        const price = `"${e.price}"`;
        const shop = `"${e.shop.replace(/"/g, '""')}"`;
        const link = `"${e.link}"`;
        return `${title},${price},${shop},${link}`;
      }).join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `taobao_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
});
