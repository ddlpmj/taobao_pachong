// Content script to scrape Taobao search results

console.log("Taobao Crawler Content Script Loaded");

// Helper to wait for elements
function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(selector)) {
            return resolve(document.querySelector(selector));
        }

        const observer = new MutationObserver(mutations => {
            if (document.querySelector(selector)) {
                resolve(document.querySelector(selector));
                observer.disconnect();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeout);
    });
}

async function scrapeData(retryCount = 0) {
    // Load state from storage
    const state = await chrome.storage.local.get(['pageLimit', 'currentPage', 'taobaoData', 'minDelay', 'maxDelay', 'lastScrapedId']);
    const pageLimit = parseInt(state.pageLimit) || 1;
    let currentPage = parseInt(state.currentPage) || 1;
    let allData = state.taobaoData || [];
    const minDelay = parseInt(state.minDelay) || 3;
    const maxDelay = parseInt(state.maxDelay) || 5;
    const lastScrapedId = state.lastScrapedId || null;

    console.log(`[Taobao Crawler] Page ${currentPage}/${pageLimit} (Retry: ${retryCount})`);

    // Visual feedback
    let statusDiv = document.getElementById('crawler-status');
    if (!statusDiv) {
        statusDiv = document.createElement('div');
        statusDiv.id = 'crawler-status';
        statusDiv.style.position = 'fixed';
        statusDiv.style.bottom = '20px';
        statusDiv.style.left = '20px';
        statusDiv.style.padding = '10px 20px';
        statusDiv.style.background = 'rgba(0,0,0,0.8)';
        statusDiv.style.color = 'white';
        statusDiv.style.borderRadius = '5px';
        statusDiv.style.zIndex = '999999';
        document.body.appendChild(statusDiv);
    }
    statusDiv.innerText = `正在检查第 ${currentPage} 页状态...`;

    // Hard stop check
    if (currentPage > pageLimit) {
        console.log("Current page exceeds limit. Stopping.");
        finishScrape(allData);
        return;
    }

    // Helper to auto-scroll
    async function autoScroll() {
        statusDiv.innerText = `正在向下滚动加载更多商品...`;
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 100;
            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight || window.innerHeight + window.scrollY >= document.body.offsetHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100); // Faster scroll
        });
        // Short wait for final renders
        await new Promise(r => setTimeout(r, 1000));
    }

    // 1. Wait for cards
    const cardSelector = 'div[class*="doubleCard--"], a[class*="doubleCardWrapperAdapt--"]';
    await waitForElement(cardSelector, 10000);

    // Execute Auto Scroll
    await autoScroll();

    const cards = document.querySelectorAll(cardSelector);
    if (cards.length === 0) {
        console.error("No cards found");
        if (currentPage === 1) alert("未找到商品，请检查页面或联系开发者。");
        return;
    }

    // Helper to extract ID
    function getItemId(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.searchParams.get('id');
        } catch (e) {
            return null;
        }
    }

    // --- OPTIONAL: Page Signature Check (Non-blocking) ---
    const firstCard = cards[0];
    let firstLink = "";
    const firstLinkEl = firstCard.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"], a');
    if (firstLinkEl) firstLink = firstLinkEl.href;
    else if (firstCard.tagName === 'A') firstLink = firstCard.href;

    const currentFirstId = getItemId(firstLink);

    if (lastScrapedId && currentFirstId && lastScrapedId === currentFirstId) {
        console.warn("Warning: Page signature matches last scraped page. Might be duplicate content.");
        statusDiv.innerText = `注意：页面可能未刷新 (第 ${currentPage} 页)...`;
        // We do NOT return here anymore. We rely on deduplication.
        // This fixes the issue where sticky ads caused scraping to stop.
    }
    // --------------------------------------

    // 2. Scrape current page
    const pageResults = [];
    cards.forEach((card, index) => {
        try {
            // --- TITLE ---
            let title = "N/A";
            // Prioritize specific Taobao classes. Remove generic 'h3' or '.title' unless necessary.
            const titleEl = card.querySelector('[class*="title--"], [class*="Title--"]');
            if (titleEl) {
                title = titleEl.innerText.trim();
            } else {
                // Fallback: Look for the first non-empty text node that looks like a title?
                // Or just use the first image alt text? 
                // Let's stick to the specific class or a very specific structure.
                // If we can't find the title class, it might not be a valid product card.
                const img = card.querySelector('img[alt]');
                if (img && img.alt.length > 5) title = img.alt;
            }

            // --- PRICE ---
            let price = "N/A";
            const priceIntEl = card.querySelector('[class*="priceInt--"], [class*="PriceInt--"]');
            const priceFloatEl = card.querySelector('[class*="priceFloat--"], [class*="PriceFloat--"]');

            if (priceIntEl) {
                price = priceIntEl.innerText + (priceFloatEl ? priceFloatEl.innerText : "");
            } else {
                // Strict Regex: Only match ¥ followed immediately by number at start of a line or block
                // Avoid matching "Save ¥20"
                const priceMatch = card.innerText.match(/(?:^|\n)¥\s*(\d+(\.\d+)?)/);
                if (priceMatch) price = priceMatch[1];
            }

            // --- SHOP ---
            let shop = "N/A";
            const shopEl = card.querySelector('[class*="shopName--"], [class*="ShopName--"], [class*="shopInfo--"]');
            if (shopEl) shop = shopEl.innerText.trim();

            // --- LINK ---
            let link = "";
            // STRICTER LINK SELECTOR: Only items and details. No generic 'a'.
            const linkEl = card.querySelector('a[href*="item.taobao.com"], a[href*="detail.tmall.com"]');

            if (linkEl) {
                link = linkEl.href;
            } else if (card.tagName === 'A' && (card.href.includes('item.taobao.com') || card.href.includes('detail.tmall.com'))) {
                link = card.href;
            }

            // Debug first item to check correctness
            if (index === 0) {
                console.log("Debug First Item:", { title, price, shop, link });
            }

            if (link && !link.startsWith('javascript') && title !== "N/A") {
                if (link.startsWith('//')) link = 'https:' + link;
                pageResults.push({ title, price, shop, link });
            }
        } catch (e) { console.error(e); }
    });

    console.log(`Page ${currentPage} scraped: ${pageResults.length} items.`);

    // Deduplicate: Filter out items that are already in allData
    const newItems = pageResults.filter(newItem => {
        const newId = getItemId(newItem.link);
        return !allData.some(existingItem => {
            const existingId = getItemId(existingItem.link);
            // If both have IDs, compare IDs
            if (newId && existingId) {
                return newId === existingId;
            }
            // Otherwise compare full links
            return existingItem.link === newItem.link;
        });
    });

    console.log(`New unique items added: ${newItems.length}`);
    allData = allData.concat(newItems);

    // Save progress AND the new signature
    await chrome.storage.local.set({
        'taobaoData': allData,
        'lastScrapedId': currentFirstId
    });

    statusDiv.innerText = `第 ${currentPage} 页完成。已获取 ${allData.length} 条。`;

    // 3. Check if we need to go to next page
    if (currentPage < pageLimit) {
        const allElements = Array.from(document.querySelectorAll('button, a, span, div'));
        const nextBtn = allElements.find(el => {
            const text = el.innerText ? el.innerText.trim() : "";
            return text === "下一页" || text === "Next >";
        });

        if (nextBtn) {
            // Calculate random delay
            const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay) * 1000;
            console.log(`Found next button. Waiting ${delay}ms before clicking...`);

            statusDiv.innerText = `本页完成。正在随机等待 ${delay / 1000} 秒...`;

            setTimeout(async () => {
                console.log("Delay finished. Clicking next page...");
                const nextPage = currentPage + 1;

                // Update state BEFORE clicking
                await chrome.storage.local.set({ 'currentPage': nextPage });

                statusDiv.innerText = `正在跳转到第 ${nextPage} 页...`;
                nextBtn.click();

                // Wait logic
                setTimeout(() => {
                    scrapeData();
                }, 5000);
            }, delay);

        } else {
            console.error("Next button not found");
            finishScrape(allData);
        }
    } else {
        console.log("Reached page limit.");
        finishScrape(allData);
    }
}

function finishScrape(data) {
    alert(`爬取完成！共爬取 ${data.length} 个商品。\n请点击插件图标导出。`);
    chrome.runtime.sendMessage({ action: "dataScraped", data: data });
    // Do NOT reset state here to prevent race conditions.
    // State is reset by popup.js when starting a new search.
}

// Auto-run logic
if (window.location.href.includes('s.taobao.com/search')) {
    const btn = document.createElement('button');
    btn.innerText = "开始爬取 (Taobao Crawler)";
    btn.style.position = "fixed";
    btn.style.top = "120px";
    btn.style.right = "20px";
    btn.style.zIndex = "99999";
    btn.style.padding = "12px 20px";
    btn.style.backgroundColor = "#ff5000";
    btn.style.color = "white";
    btn.style.border = "2px solid white";
    btn.style.borderRadius = "25px";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.2)";
    btn.style.fontWeight = "bold";

    btn.onclick = () => {
        // Reset state on manual click
        chrome.storage.local.set({ 'currentPage': 1, 'taobaoData': [] }, () => {
            scrapeData();
        });
    };
    document.body.appendChild(btn);

    // Check if we are in a multi-page sequence
    chrome.storage.local.get(['pageLimit', 'currentPage'], (result) => {
        // Only auto-run if we are NOT on the first page (user must manually start the first page)
        // AND we haven't reached the limit yet.
        if (result.pageLimit > 1 && result.currentPage > 1 && result.currentPage <= result.pageLimit) {
            console.log("Continuing multi-page scrape (Page " + result.currentPage + ")...");
            setTimeout(scrapeData, 3000);
        } else {
            console.log("Waiting for user to start scraping...");
        }
    });
}
