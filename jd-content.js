// Content script to scrape JD.com search results

console.log("JD Crawler Content Script Loaded");

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
    const state = await chrome.storage.local.get(['pageLimit', 'currentPage', 'jdData', 'minDelay', 'maxDelay', 'lastScrapedId']);
    const pageLimit = parseInt(state.pageLimit) || 1;
    let currentPage = parseInt(state.currentPage) || 1;
    let allData = state.jdData || [];
    const minDelay = parseInt(state.minDelay) || 3;
    const maxDelay = parseInt(state.maxDelay) || 5;
    const lastScrapedId = state.lastScrapedId || null;

    console.log(`[JD Crawler] Page ${currentPage}/${pageLimit} (Retry: ${retryCount})`);

    // Visual feedback
    let statusDiv = document.getElementById('crawler-status');
    if (!statusDiv) {
        statusDiv = document.createElement('div');
        statusDiv.id = 'crawler-status';
        statusDiv.style.position = 'fixed';
        statusDiv.style.bottom = '20px';
        statusDiv.style.left = '20px';
        statusDiv.style.padding = '10px 20px';
        statusDiv.style.background = 'rgba(255,0,0,0.8)'; // JD Red
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

    // Helper to auto-scroll - improved version for better loading
    async function autoScroll() {
        statusDiv.innerText = `正在向下滚动加载更多商品...`;
        
        let lastHeight = 0;
        let currentHeight = document.body.scrollHeight;
        let scrollAttempts = 0;
        const maxScrollAttempts = 50; // Prevent infinite loop
        
        // Scroll down multiple times to trigger lazy loading
        while (currentHeight !== lastHeight && scrollAttempts < maxScrollAttempts) {
            lastHeight = currentHeight;
            
            // Scroll to bottom
            window.scrollTo(0, document.body.scrollHeight);
            
            // Wait for content to load
            await new Promise(r => setTimeout(r, 500));
            
            // Check if new content loaded
            currentHeight = document.body.scrollHeight;
            scrollAttempts++;
            
            // Also check if we've scrolled enough
            if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 100) {
                break;
            }
        }
        
        // Scroll back to top to ensure all elements are in viewport
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 500));
        
        // Scroll down again slowly to trigger any remaining lazy loads
        let scrollPosition = 0;
        const scrollStep = 300;
        const maxScroll = document.body.scrollHeight;
        
        while (scrollPosition < maxScroll) {
            window.scrollTo(0, scrollPosition);
            scrollPosition += scrollStep;
            await new Promise(r => setTimeout(r, 200));
        }
        
        // Final scroll to bottom
        window.scrollTo(0, document.body.scrollHeight);
        
        // Wait longer for final renders and lazy loading
        await new Promise(r => setTimeout(r, 2000));
        
        // Check if more content loaded after waiting
        const finalHeight = document.body.scrollHeight;
        if (finalHeight > currentHeight) {
            console.log("Additional content loaded, waiting more...");
            await new Promise(r => setTimeout(r, 1500));
        }
        
        statusDiv.innerText = `滚动完成，开始提取商品数据...`;
    }

    // 1. Wait for product cards - JD uses different selectors
    // Desktop: .gl-item, .p-name, .p-price
    // Mobile: .item, .p-name, .p-price
    // New mobile structure: .plugin_goodsCardWrapper, [data-sku]
    // Priority: Use most specific selectors first to avoid false positives
    const cardSelectors = [
        '.plugin_goodsCardWrapper',  // Most specific - new mobile structure
        '[data-sku]',  // Also specific - has SKU attribute
        '.gl-item',  // Desktop structure
        '.item'  // Mobile structure (but may match other items)
    ];
    
    let cards = [];
    let bestSelector = null;
    let maxCards = 0;
    
    // Try each selector and pick the one that finds reasonable number of cards
    for (const selector of cardSelectors) {
        await waitForElement(selector, 3000);
        const foundCards = document.querySelectorAll(selector);
        const count = foundCards.length;
        
        console.log(`Selector "${selector}" found ${count} cards`);
        
        // Prefer selectors that find between 20-200 cards (reasonable product count per page)
        // Avoid selectors that find too many (likely false positives)
        if (count > 0) {
            if (count >= 20 && count <= 200) {
                // This looks like a good match
                cards = foundCards;
                bestSelector = selector;
                maxCards = count;
                console.log(`✅ Using selector: ${selector} (${count} cards)`);
                break;
            } else if (count > 0 && count < 20 && maxCards === 0) {
                // Keep as fallback if no better option
                cards = foundCards;
                bestSelector = selector;
                maxCards = count;
            } else if (count > 200 && maxCards === 0) {
                // Too many matches, likely false positives, but use if nothing else
                console.warn(`⚠️ Selector "${selector}" found ${count} cards (may include false positives)`);
                // Don't use this unless we have no other option
            }
        }
    }
    
    // If we found cards with a good selector, use them
    if (cards.length > 0 && bestSelector) {
        console.log(`Using ${cards.length} cards from selector: ${bestSelector}`);
    }

    // If still no cards, try to find any element with price info
    if (cards.length === 0 || cards.length > 500) {
        console.log("Trying fallback: looking for elements with price");
        // Use more specific price selectors for new mobile structure
        const priceSelectors = [
            'span._price_d0rf6_14',
            '[class*="_price_d0rf6"]',
            '.p-price',
            '.J_price',
            '[class*="p-price"]'
        ];
        
        const parentCards = new Set();
        for (const priceSelector of priceSelectors) {
            const priceElements = document.querySelectorAll(priceSelector);
            if (priceElements.length > 0) {
                console.log(`Found ${priceElements.length} price elements with selector: ${priceSelector}`);
                priceElements.forEach(el => {
                    // Find parent that has data-sku or is a goodsCardWrapper
                    let parent = el.closest('[data-sku], .plugin_goodsCardWrapper, [class*="goodsCardWrapper"]');
                    if (!parent) {
                        parent = el.closest('li, div[class*="gl-item"], div[class*="item"]');
                    }
                    if (parent) parentCards.add(parent);
                });
                if (parentCards.size > 0 && parentCards.size <= 200) {
                    break; // Found reasonable number, stop
                }
            }
        }
        
        if (parentCards.size > 0 && parentCards.size <= 200) {
            cards = Array.from(parentCards);
            console.log(`✅ Found ${cards.length} cards using price fallback`);
        } else if (parentCards.size > 200) {
            console.warn(`⚠️ Price fallback found ${parentCards.size} cards (may include false positives)`);
            // Filter to only those with data-sku
            const filtered = Array.from(parentCards).filter(card => 
                card.getAttribute('data-sku') || card.querySelector('[data-sku]')
            );
            if (filtered.length > 0) {
                cards = filtered;
                console.log(`✅ Filtered to ${cards.length} cards with data-sku`);
            }
        }
    }

    // Execute Auto Scroll
    await autoScroll();

    // Additional wait for dynamic content after scroll
    await new Promise(r => setTimeout(r, 1500));

    // Re-check cards after scroll - but be careful not to use overly broad selectors
    const currentCount = cards.length;
    
    // Only re-check with specific selectors
    const specificSelectors = ['.plugin_goodsCardWrapper', '[data-sku]'];
    for (const selector of specificSelectors) {
        const foundCards = document.querySelectorAll(selector);
        if (foundCards.length > currentCount && foundCards.length <= 200) {
            cards = foundCards;
            console.log(`✅ Found ${cards.length} cards after scroll using: ${selector}`);
            break;
        }
    }
    
    // Final check: ensure we're using the most specific selector
    const skuElements = document.querySelectorAll('[data-sku]');
    if (skuElements.length > 0 && skuElements.length <= 200) {
        // Filter to only those that are actual product cards (have price or title)
        const validCards = Array.from(skuElements).filter(card => {
            const hasPrice = card.querySelector('span._price_d0rf6_14, [class*="_price"], .p-price');
            const hasTitle = card.querySelector('span._text_1g56m_31, [class*="name"], .p-name');
            return hasPrice || hasTitle;
        });
        
        if (validCards.length > 0) {
            cards = validCards;
            console.log(`✅ Filtered to ${cards.length} valid product cards with data-sku`);
        }
    }

    if (cards.length === 0) {
        console.error("No cards found. Page structure:", document.body.innerHTML.substring(0, 500));
        if (currentPage === 1) alert("未找到商品卡片。请打开浏览器控制台(F12)查看详细信息。");
        return;
    }
    
    console.log(`Total cards found: ${cards.length}`);
    
    // Log card count by selector for debugging
    console.log("Card count by selector:");
    cardSelectors.forEach(selector => {
        const count = document.querySelectorAll(selector).length;
        if (count > 0) {
            console.log(`  ${selector}: ${count}`);
        }
    });
    
    // Check for lazy-loaded images that might indicate more content
    const lazyImages = document.querySelectorAll('img[data-src], img[data-lazy]');
    if (lazyImages.length > 0) {
        console.log(`Found ${lazyImages.length} lazy-loaded images, waiting for them to load...`);
        await new Promise(r => setTimeout(r, 2000));
        
        // Re-check cards after lazy images load
        for (const selector of cardSelectors) {
            const foundCards = document.querySelectorAll(selector);
            if (foundCards.length > cards.length) {
                cards = foundCards;
                console.log(`Found ${cards.length} cards after lazy images loaded using: ${selector}`);
            }
        }
    }

    // Helper to extract ID from JD URL
    function getItemId(url) {
        try {
            // JD URLs: https://item.jd.com/123456.html or https://item.m.jd.com/product/123456.html
            const match = url.match(/\/\d+\.html/);
            if (match) {
                return match[0].replace(/[\/\.html]/g, '');
            }
            // Alternative: /product/123456
            const productMatch = url.match(/\/product\/(\d+)/);
            if (productMatch) {
                return productMatch[1];
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // --- OPTIONAL: Page Signature Check (Non-blocking) ---
    const firstCard = cards[0];
    let firstLink = "";
    const firstLinkEl = firstCard.querySelector('a[href*="item.jd.com"], a[href*="item.m.jd.com"], a[href*="/product/"], a');
    if (firstLinkEl) firstLink = firstLinkEl.href;
    else if (firstCard.tagName === 'A') firstLink = firstCard.href;

    const currentFirstId = getItemId(firstLink);

    if (lastScrapedId && currentFirstId && lastScrapedId === currentFirstId) {
        console.warn("Warning: Page signature matches last scraped page. Might be duplicate content.");
        statusDiv.innerText = `注意：页面可能未刷新 (第 ${currentPage} 页)...`;
    }
    // --------------------------------------

    // 2. Scrape current page
    const pageResults = [];
    cards.forEach((card, index) => {
        try {
            // --- TITLE ---
            let title = "N/A";
            // JD selectors - try new mobile structure first, then desktop
            const titleSelectors = [
                'span._text_1g56m_31',  // New mobile structure
                '.goods_title_container span',
                '[class*="goods_title"] span',
                '[class*="_text_1g56m"]',
                '.p-name em',
                '.p-name',
                '.p-name-type-2',
                '[class*="p-name"] em',
                '[class*="p-name"]',
                'em[class*="name"]',
                'a[class*="name"]',
                '[class*="name"]',
                '[class*="Name"]',
                '[class*="title"]',
                '[class*="Title"]',
                'h3',
                'h4',
                '.title',
                '.name'
            ];
            
            for (const selector of titleSelectors) {
                const titleEl = card.querySelector(selector);
                if (titleEl) {
                    // Get text content, removing font tags and other inline elements
                    let text = '';
                    if (titleEl.innerText) {
                        text = titleEl.innerText;
                    } else if (titleEl.textContent) {
                        text = titleEl.textContent;
                    } else {
                        // Fallback: get all text nodes
                        const walker = document.createTreeWalker(
                            titleEl,
                            NodeFilter.SHOW_TEXT,
                            null,
                            false
                        );
                        const textNodes = [];
                        let node;
                        while (node = walker.nextNode()) {
                            textNodes.push(node.textContent);
                        }
                        text = textNodes.join(' ');
                    }
                    title = text.trim().replace(/\s+/g, ' ');
                    if (title && title.length > 5) {
                        break;
                    }
                }
            }
            
            // Fallback: try title attribute
            if (title === "N/A" || title.length <= 5) {
                const titleAttr = card.querySelector('[title]');
                if (titleAttr && titleAttr.getAttribute('title')) {
                    title = titleAttr.getAttribute('title').trim();
                }
            }
            
            // Fallback: try img alt or title
            if (title === "N/A" || title.length <= 5) {
                const img = card.querySelector('img[alt], img[title]');
                if (img) {
                    title = (img.alt || img.title || '').trim();
                    if (title.length <= 5) title = "N/A";
                }
            }
            
            // Last resort: get first meaningful text from card
            if (title === "N/A" || title.length <= 5) {
                const cardText = (card.innerText || card.textContent || '').trim();
                const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
                // Skip price lines (contain ¥ or numbers)
                const textLines = lines.filter(l => !l.match(/[¥￥]\s*\d/) && !l.match(/^\d+$/) && !l.match(/已售|好评|券|包邮/));
                if (textLines.length > 0) {
                    title = textLines[0].substring(0, 100);
                }
            }

            // --- PRICE ---
            let price = "N/A";
            // JD price selectors - try new mobile structure first
            const priceSelectors = [
                'span._price_d0rf6_14',  // New mobile structure
                '[class*="_price_d0rf6"]',
                '.p-price i',
                '.p-price',
                '.J_price',
                '[class*="p-price"] i',
                '[class*="p-price"]',
                '[class*="price"] i',
                '[class*="price"]',
                '[class*="Price"]',
                'i[class*="price"]',
                'strong[class*="price"]',
                '.price',
                '[data-price]'
            ];
            
            let priceEl = null;
            for (const selector of priceSelectors) {
                priceEl = card.querySelector(selector);
                if (priceEl) {
                    // Get text including child elements
                    const priceText = (priceEl.innerText || priceEl.textContent || '').trim();
                    if (priceText.match(/[¥￥\d]/)) break; // Found price-like content
                }
            }
            
            if (priceEl) {
                // JD price format: ¥99.00 or ￥99.00 or ¥579
                // New structure: <span><i>¥</i>579</span> or <span><i>¥</i>99.90</span>
                // Get all text including child elements
                let priceText = '';
                
                // Try to get text from the price element and its children
                if (priceEl.innerText) {
                    priceText = priceEl.innerText.trim();
                } else if (priceEl.textContent) {
                    priceText = priceEl.textContent.trim();
                } else {
                    // Fallback: manually extract from child nodes
                    const walker = document.createTreeWalker(
                        priceEl,
                        NodeFilter.SHOW_TEXT,
                        null,
                        false
                    );
                    const textNodes = [];
                    let node;
                    while (node = walker.nextNode()) {
                        textNodes.push(node.textContent.trim());
                    }
                    priceText = textNodes.join('').trim();
                }
                
                // Match price with optional decimal: ¥99.90 or ¥579 or 99.90 or 579
                // Pattern: [¥￥]? optional currency symbol, then digits with optional decimal
                const priceMatch = priceText.match(/[¥￥]?\s*(\d+\.?\d*)/);
                if (priceMatch) {
                    // Ensure we preserve decimal if present
                    let priceValue = priceMatch[1];
                    // If no decimal point but should have one (like 99 should be 99.00 for consistency)
                    // Actually, let's keep it as is - if it's 579, keep it as 579, not 579.00
                    price = priceValue;
                } else {
                    // Try to extract any number sequence
                    const numMatch = priceText.match(/(\d+\.?\d*)/);
                    if (numMatch) {
                        price = numMatch[1];
                    } else if (priceText.length < 20 && priceText.match(/\d/)) {
                        // If text is short and contains digits, use it
                        price = priceText.replace(/[¥￥\s]/g, '');
                    }
                }
            }
            
            // Fallback: regex search in card text - improved pattern
            if (price === "N/A") {
                const cardText = (card.innerText || card.textContent || '').trim();
                // More comprehensive price pattern: matches ¥99.90, ¥579, 99.90, etc.
                const priceMatch = cardText.match(/[¥￥]\s*(\d+\.?\d*)/);
                if (priceMatch) {
                    price = priceMatch[1];
                } else {
                    // Try without currency symbol
                    const numMatch = cardText.match(/(\d+\.\d{1,2})/); // Match decimal prices
                    if (numMatch) {
                        price = numMatch[1];
                    }
                }
            }
            
            // Clean up price: ensure it's a valid number format
            if (price !== "N/A" && price) {
                // Remove any non-digit characters except decimal point
                price = price.toString().replace(/[^\d.]/g, '');
                // Ensure only one decimal point
                const parts = price.split('.');
                if (parts.length > 2) {
                    price = parts[0] + '.' + parts.slice(1).join('');
                }
                // If empty after cleaning, set to N/A
                if (!price || price === '') {
                    price = "N/A";
                }
            }

            // --- SHOP ---
            let shop = "N/A";
            // JD shop selectors - try new mobile structure first
            const shopSelectors = [
                'span._name_d19t5_35',  // New mobile structure
                '[class*="_name_d19t5"]',
                '.shopFloor span',
                '[class*="shopFloor"] span',
                '.p-shop',
                '.shop-name',
                '[class*="p-shop"]',
                '[class*="shop"]',
                '[class*="Shop"]',
                '[class*="store"]',
                '[class*="Store"]'
            ];
            
            for (const selector of shopSelectors) {
                const shopEl = card.querySelector(selector);
                if (shopEl) {
                    shop = (shopEl.innerText || shopEl.textContent || '').trim();
                    if (shop && shop.length > 0) break;
                }
            }

            // --- SALES VOLUME (销量) ---
            let sales = "N/A";
            // JD sales selectors - new mobile structure
            const salesSelectors = [
                'span._goods_volume_1xkku_1 span[title*="已售"]',  // New mobile structure
                '[class*="_goods_volume"] span[title*="已售"]',
                '[class*="goods_volume"] span',
                '.p-commit',
                '[class*="commit"]',
                '[class*="sales"]',
                '[class*="Sales"]'
            ];
            
            for (const selector of salesSelectors) {
                const salesEl = card.querySelector(selector);
                if (salesEl) {
                    // Try title attribute first (more accurate)
                    const title = salesEl.getAttribute('title');
                    if (title && title.includes('已售')) {
                        sales = title.replace('已售', '').trim();
                    } else {
                        const text = (salesEl.innerText || salesEl.textContent || '').trim();
                        if (text.includes('已售') || text.includes('售') || text.match(/\d+[万千百]/)) {
                            sales = text.replace('已售', '').trim();
                        }
                    }
                    if (sales && sales !== "N/A") break;
                }
            }
            
            // Fallback: search in card text
            if (sales === "N/A") {
                const cardText = (card.innerText || card.textContent || '').trim();
                const salesMatch = cardText.match(/已售([\d万千百]+[\+\-]?)/);
                if (salesMatch) {
                    sales = salesMatch[1];
                }
            }

            // --- RATING (好评率) ---
            let rating = "N/A";
            // JD rating selectors - new mobile structure
            const ratingSelectors = [
                'span._tml_1xkku_12[title*="好评"]',  // New mobile structure
                '[class*="_tml_1xkku"] [title*="好评"]',
                '[class*="goods_volume"] span[title*="好评"]',
                '.p-commit strong',
                '[class*="rate"]',
                '[class*="Rate"]',
                '[class*="rating"]'
            ];
            
            for (const selector of ratingSelectors) {
                const ratingEl = card.querySelector(selector);
                if (ratingEl) {
                    // Try title attribute first (more accurate)
                    const title = ratingEl.getAttribute('title');
                    if (title && title.includes('好评')) {
                        const ratingMatch = title.match(/(\d+%)/);
                        if (ratingMatch) {
                            rating = ratingMatch[1];
                        } else {
                            rating = title.replace('好评', '').trim();
                        }
                    } else {
                        const text = (ratingEl.innerText || ratingEl.textContent || '').trim();
                        if (text.includes('%') || text.includes('好评')) {
                            const ratingMatch = text.match(/(\d+%)/);
                            if (ratingMatch) {
                                rating = ratingMatch[1];
                            } else {
                                rating = text.replace('好评', '').trim();
                            }
                        }
                    }
                    if (rating && rating !== "N/A") break;
                }
            }
            
            // Fallback: search in card text
            if (rating === "N/A") {
                const cardText = (card.innerText || card.textContent || '').trim();
                const ratingMatch = cardText.match(/(\d+%)好评/);
                if (ratingMatch) {
                    rating = ratingMatch[1];
                }
            }

            // --- LINK ---
            let link = "";
            // JD link selectors - prioritize product links, exclude search links
            const linkSelectors = [
                'a[href*="item.jd.com"]',
                'a[href*="item.m.jd.com"]',
                'a[href*="/product/"]',
                'a[href*="ware.action"]',
                'a[href^="//item"]',
                'a[href^="/item"]'
            ];
            
            let linkEl = null;
            for (const selector of linkSelectors) {
                const links = card.querySelectorAll(selector);
                for (const el of links) {
                    const href = el.href || el.getAttribute('href') || '';
                    // Exclude search links
                    if (href && !href.includes('Search?') && !href.includes('search.jd.com')) {
                        linkEl = el;
                        break;
                    }
                }
                if (linkEl) break;
            }

            if (linkEl && linkEl.href) {
                link = linkEl.href;
            } else if (card.tagName === 'A' && card.href) {
                const href = card.href;
                if ((href.includes('item.jd.com') || 
                     href.includes('item.m.jd.com') || 
                     href.includes('/product/') ||
                     href.includes('ware.action')) &&
                    !href.includes('Search?')) {
                    link = href;
                }
            } else {
                // Try to find any link in the card, but exclude search links
                const allLinks = card.querySelectorAll('a[href]');
                for (const anyLink of allLinks) {
                    const href = anyLink.href || anyLink.getAttribute('href') || '';
                    // Exclude search links and navigation links
                    if (href && 
                        !href.includes('Search?') && 
                        !href.includes('search.jd.com') &&
                        !href.includes('javascript:') &&
                        (href.includes('item.jd.com') || 
                         href.includes('item.m.jd.com') || 
                         href.includes('/product/') ||
                         href.includes('ware.action') ||
                         href.match(/\/\d+\.html/))) {
                        link = href;
                        break;
                    }
                }
            }
            
            // Try to extract product ID from data attributes and construct link
            // This is the primary method for new mobile structure
            if (!link || link.includes('Search?') || link.includes('search.jd.com')) {
                const dataId = card.getAttribute('data-sku') || 
                              card.getAttribute('data-id') ||
                              card.getAttribute('data-pid') ||
                              card.closest('[data-sku]')?.getAttribute('data-sku') ||
                              card.querySelector('[data-sku]')?.getAttribute('data-sku') ||
                              card.querySelector('[data-id]')?.getAttribute('data-id');
                if (dataId && /^\d+$/.test(dataId)) {
                    link = `https://item.jd.com/${dataId}.html`;
                }
            }

            // Normalize link
            if (link) {
                if (link.startsWith('//')) link = 'https:' + link;
                if (link.startsWith('/')) link = 'https://www.jd.com' + link;
                // Remove search parameters if it's a product link
                if (link.includes('item.jd.com')) {
                    link = link.split('?')[0];
                }
            }

            // Debug first few items - more detailed
            if (index < 3) {
                const titleEls = card.querySelectorAll('[class*="name"], [class*="title"], .p-name, em, h3, h4');
                const priceEls = card.querySelectorAll('[class*="price"], .p-price, .J_price, i, strong');
                const linkEls = card.querySelectorAll('a[href]');
                
                // Debug price extraction for first few items
                const priceEl = card.querySelector('span._price_d0rf6_14, [class*="_price_d0rf6"], .p-price, .J_price, [class*="price"]');
                const priceDebug = priceEl ? {
                    elementHTML: priceEl.outerHTML.substring(0, 200),
                    innerText: priceEl.innerText,
                    textContent: priceEl.textContent,
                    allText: Array.from(priceEl.childNodes).map(n => n.textContent).join('')
                } : null;
                
                console.log(`🔍 Debug Item ${index + 1}:`, { 
                    title, 
                    price, 
                    shop,
                    sales,
                    rating,
                    link: link ? link.substring(0, 80) : 'NO LINK',
                    titleFound: title !== "N/A",
                    priceFound: price !== "N/A",
                    salesFound: sales !== "N/A",
                    ratingFound: rating !== "N/A",
                    linkFound: !!link && !link.includes('Search?'),
                    cardClass: card.className,
                    cardTag: card.tagName,
                    priceDebug: priceDebug
                });
            }

            // More lenient condition: accept if we have title OR link OR price
            // Try to extract product ID from data attributes
            if (!link || link.startsWith('javascript')) {
                const dataId = card.getAttribute('data-sku') || 
                              card.getAttribute('data-id') ||
                              card.getAttribute('data-pid') ||
                              card.querySelector('[data-sku]')?.getAttribute('data-sku') ||
                              card.querySelector('[data-id]')?.getAttribute('data-id');
                if (dataId) {
                    link = `https://item.jd.com/${dataId}.html`;
                }
            }
            
            // Extract from any link in the card if still no link
            if (!link || link.startsWith('javascript')) {
                const allLinks = card.querySelectorAll('a[href]');
                for (const a of allLinks) {
                    const href = a.href;
                    if (href && (href.includes('item.jd.com') || href.includes('product') || href.match(/\/\d+\.html/))) {
                        link = href;
                        break;
                    }
                }
            }
            
            // Normalize link again
            if (link) {
                if (link.startsWith('//')) link = 'https:' + link;
                if (link.startsWith('/')) link = 'https://www.jd.com' + link;
            }
            
            // Very lenient: add if we have at least title OR price OR link OR data-sku
            const hasTitle = title !== "N/A" && title.length > 3;
            const hasPrice = price !== "N/A" && price !== "";
            const hasLink = link && !link.startsWith('javascript') && link.length > 10;
            const hasSku = card.getAttribute('data-sku') || card.closest('[data-sku]');
            
            // Get titleEls for fallback
            const titleEls = card.querySelectorAll('[class*="name"], [class*="title"], .p-name, span._text_1g56m_31');
            
            // Always try to extract data, even if some fields are N/A
            // Ensure we have at least a placeholder title
            if (!hasTitle) {
                // Try multiple methods to get title
                if (titleEls.length > 0) {
                    for (const el of titleEls) {
                        const text = (el.innerText || el.textContent || '').trim();
                        if (text && text.length > 5) {
                            title = text.substring(0, 100);
                            break;
                        }
                    }
                }
                
                // Fallback: get from card text
                if (title === "N/A" || title.length <= 3) {
                    const cardText = (card.innerText || card.textContent || '').trim();
                    const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
                    // Skip price lines and other noise
                    const textLines = lines.filter(l => 
                        !l.match(/[¥￥]\s*\d/) && 
                        !l.match(/^\d+$/) && 
                        !l.match(/已售|好评|券|包邮|关注|对比|搜同款/)
                    );
                    if (textLines.length > 0) {
                        title = textLines[0].substring(0, 100);
                    } else if (lines.length > 0) {
                        title = lines[0].substring(0, 100);
                    } else {
                        title = '商品';
                    }
                }
            }
            
            // Ensure we have at least a placeholder link
            if (!hasLink) {
                // Try to find any link in card
                const anyLink = card.querySelector('a[href]');
                if (anyLink && anyLink.href && !anyLink.href.includes('Search?')) {
                    link = anyLink.href;
                } else if (hasSku) {
                    // Use data-sku to construct link
                    const sku = card.getAttribute('data-sku') || card.closest('[data-sku]')?.getAttribute('data-sku');
                    if (sku && /^\d+$/.test(sku)) {
                        link = `https://item.jd.com/${sku}.html`;
                    }
                } else if (title && title !== '商品') {
                    link = `https://search.jd.com/Search?keyword=${encodeURIComponent(title.substring(0, 20))}`;
                } else {
                    link = 'https://www.jd.com';
                }
            }
            
            // Normalize link one more time
            if (link) {
                if (link.startsWith('//')) link = 'https:' + link;
                if (link.startsWith('/')) link = 'https://www.jd.com' + link;
            }
            
            // Always add item if we have at least title or link or sku
            // This ensures we don't lose any products
            if (title && title !== "N/A" && title.length > 0) {
                pageResults.push({ title, price, shop, link, sales, rating });
            } else if (hasLink || hasSku) {
                // Even if no title, add if we have link or sku
                if (!title || title === "N/A") {
                    title = '商品';
                }
                pageResults.push({ title, price, shop, link, sales, rating });
            } else if (index < 10) {
                // Log why item was skipped (for debugging)
                console.log(`⚠️ Skipped item ${index + 1}:`, { 
                    hasTitle, 
                    hasPrice, 
                    hasLink,
                    hasSku: !!hasSku,
                    title, 
                    price, 
                    link,
                    cardClass: card.className,
                    cardHTML: card.outerHTML.substring(0, 300),
                    cardText: (card.innerText || card.textContent || '').substring(0, 200)
                });
            }
        } catch (e) { 
            console.error(`Error scraping card ${index}:`, e); 
        }
    });

    console.log(`Page ${currentPage} scraped: ${pageResults.length} items.`);
    
    // Debug: Log page structure if no items found or if many items have N/A
    const naCount = pageResults.filter(item => 
        item.title === "N/A" && item.price === "N/A" && item.shop === "N/A"
    ).length;
    
    if (pageResults.length === 0 && cards.length > 0) {
        console.warn("⚠️ No items extracted! Debugging first card:");
        const sampleCard = cards[0];
        console.log("Card tag:", sampleCard.tagName);
        console.log("Card class:", sampleCard.className);
        console.log("Card data-sku:", sampleCard.getAttribute('data-sku'));
        console.log("Card text (first 500 chars):", (sampleCard.innerText || sampleCard.textContent || '').substring(0, 500));
        
        const allLinks = Array.from(sampleCard.querySelectorAll('a[href]'));
        console.log(`Found ${allLinks.length} links:`, allLinks.map(a => ({
            href: (a.href || a.getAttribute('href') || '').substring(0, 100),
            text: (a.innerText || a.textContent || '').substring(0, 30)
        })));
        
        const allPrices = Array.from(sampleCard.querySelectorAll('[class*="price"], [class*="Price"], .p-price, .J_price, span._price_d0rf6_14'));
        console.log(`Found ${allPrices.length} price elements:`, allPrices.map(el => ({
            class: el.className,
            innerText: el.innerText,
            textContent: el.textContent,
            html: el.outerHTML.substring(0, 150)
        })));
        
        const allTitles = Array.from(sampleCard.querySelectorAll('[class*="name"], [class*="title"], .p-name, em, span._text_1g56m_31'));
        console.log(`Found ${allTitles.length} title/name elements:`, allTitles.map(el => ({
            class: el.className,
            tag: el.tagName,
            innerText: (el.innerText || '').substring(0, 50),
            textContent: (el.textContent || '').substring(0, 50)
        })));
        
        console.log("Card HTML (first 1000 chars):", sampleCard.outerHTML.substring(0, 1000));
    } else if (naCount > pageResults.length * 0.5) {
        console.warn(`⚠️ Warning: ${naCount}/${pageResults.length} items have mostly N/A values. Checking extraction...`);
        const sampleItem = pageResults.find(item => item.title !== "N/A" || item.price !== "N/A");
        if (sampleItem) {
            console.log("Sample extracted item:", sampleItem);
        }
    }

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
        'jdData': allData,
        'lastScrapedId': currentFirstId
    });

    statusDiv.innerText = `第 ${currentPage} 页完成。已获取 ${allData.length} 条。`;

    // 3. Check if we need to go to next page
    if (currentPage < pageLimit) {
        const nextPage = currentPage + 1;
        
        // Try multiple methods to find next page button
        let nextBtn = null;
        
        // Method 1: Look for pagination buttons with text - prioritize specific JD classes
        const specificSelectors = [
            'div._pagination_next_1jczn_8',  // Specific JD mobile pagination class
            '[class*="_pagination_next"]',  // Match similar classes
            '[class*="pagination_next"]',
            '[class*="pager-next"]',
            '.pager-next',
            '.pagination-next'
        ];
        
        for (const selector of specificSelectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                nextBtn = elements[0];
                console.log(`Found next button using selector: ${selector}`);
                break;
            }
        }
        
        // Method 1b: Look for pagination buttons with text (fallback)
        if (!nextBtn) {
            const allElements = Array.from(document.querySelectorAll('button, a, span, div, li'));
            nextBtn = allElements.find(el => {
                const text = (el.innerText || el.textContent || '').trim();
                const ariaLabel = el.getAttribute('aria-label') || '';
                const className = el.className || '';
                
                return text === "下一页" || 
                       text === "Next >" || 
                       text === ">" ||
                       text === "›" ||
                       text.includes("下一页") ||
                       text.includes("next") ||
                       ariaLabel === '下一页' ||
                       ariaLabel.includes('next') ||
                       className.includes('next') ||
                       className.includes('pager-next') ||
                       className.includes('pagination-next');
            });
        }
        
        // Method 2: Look for pagination links with page number
        if (!nextBtn) {
            const pageLinks = document.querySelectorAll('a[href*="page="], a[href*="Page="], a[href*="p="]');
            for (const link of pageLinks) {
                const href = link.href || link.getAttribute('href') || '';
                const text = (link.innerText || link.textContent || '').trim();
                // Check if link points to next page
                if (href.includes(`page=${nextPage}`) || 
                    href.includes(`Page=${nextPage}`) ||
                    href.includes(`p=${nextPage}`) ||
                    text === String(nextPage) ||
                    text === "下一页") {
                    nextBtn = link;
                    break;
                }
            }
        }
        
        // Method 3: Look for pagination container and find next button
        if (!nextBtn) {
            const paginationContainers = document.querySelectorAll('.pager, .pagination, [class*="pager"], [class*="pagination"], [class*="page"]');
            for (const container of paginationContainers) {
                const buttons = container.querySelectorAll('a, button, span, li');
                for (const btn of buttons) {
                    const text = (btn.innerText || btn.textContent || '').trim();
                    if (text === "下一页" || text === String(nextPage) || text === ">" || text === "›") {
                        nextBtn = btn;
                        break;
                    }
                }
                if (nextBtn) break;
            }
        }
        
        // Method 4: Try to construct next page URL and navigate
        if (!nextBtn) {
            const currentUrl = window.location.href;
            let nextUrl = null;
            
            // Try to modify URL to go to next page
            if (currentUrl.includes('page=')) {
                nextUrl = currentUrl.replace(/page=(\d+)/, `page=${nextPage}`);
            } else if (currentUrl.includes('Page=')) {
                nextUrl = currentUrl.replace(/Page=(\d+)/, `Page=${nextPage}`);
            } else if (currentUrl.includes('p=')) {
                nextUrl = currentUrl.replace(/p=(\d+)/, `p=${nextPage}`);
            } else if (currentUrl.includes('search.jd.com')) {
                // JD search URL format: https://search.jd.com/Search?keyword=xxx&page=2
                const separator = currentUrl.includes('?') ? '&' : '?';
                nextUrl = currentUrl + separator + `page=${nextPage}`;
            }
            
            if (nextUrl && nextUrl !== currentUrl) {
                console.log(`Using URL navigation to page ${nextPage}: ${nextUrl}`);
                // Calculate random delay
                const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay) * 1000;
                console.log(`Waiting ${delay}ms before navigating...`);
                
                statusDiv.innerText = `本页完成。正在随机等待 ${delay / 1000} 秒...`;
                
                setTimeout(async () => {
                    console.log("Delay finished. Navigating to next page...");
                    await chrome.storage.local.set({ 'currentPage': nextPage });
                    statusDiv.innerText = `正在跳转到第 ${nextPage} 页...`;
                    window.location.href = nextUrl;
                }, delay);
                return; // Exit function, navigation will reload page
            }
        }

        if (nextBtn) {
            // Calculate random delay
            const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay) * 1000;
            console.log(`Found next button. Tag: ${nextBtn.tagName}, Class: ${nextBtn.className}, Text: "${nextBtn.innerText || nextBtn.textContent}", Waiting ${delay}ms before clicking...`);

            statusDiv.innerText = `本页完成。正在随机等待 ${delay / 1000} 秒...`;

            setTimeout(async () => {
                console.log("Delay finished. Clicking next page...");
                
                // Update state BEFORE clicking
                await chrome.storage.local.set({ 'currentPage': nextPage });

                statusDiv.innerText = `正在跳转到第 ${nextPage} 页...`;
                
                // Try multiple click methods for div elements
                let clicked = false;
                
                // Method 1: Check if it's a link and use href
                if (nextBtn.tagName === 'A' && nextBtn.href) {
                    console.log("Next button is a link, using href:", nextBtn.href);
                    window.location.href = nextBtn.href;
                    clicked = true;
                }
                
                // Method 2: Check for onclick handler
                if (!clicked && nextBtn.onclick) {
                    console.log("Next button has onclick handler, calling it");
                    try {
                        nextBtn.onclick();
                        clicked = true;
                    } catch (e) {
                        console.warn("onclick failed:", e);
                    }
                }
                
                // Method 3: Dispatch click event (works for div elements)
                if (!clicked) {
                    console.log("Dispatching click event on div element");
                    try {
                        const clickEvent = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            detail: 1
                        });
                        nextBtn.dispatchEvent(clickEvent);
                        clicked = true;
                    } catch (e) {
                        console.warn("dispatchEvent failed:", e);
                    }
                }
                
                // Method 4: Direct click (fallback)
                if (!clicked) {
                    console.log("Trying direct click");
                    try {
                        nextBtn.click();
                        clicked = true;
                    } catch (e) {
                        console.warn("Direct click failed:", e);
                    }
                }
                
                // Method 5: Find parent link or button
                if (!clicked) {
                    const parentLink = nextBtn.closest('a');
                    if (parentLink && parentLink.href) {
                        console.log("Found parent link, navigating:", parentLink.href);
                        window.location.href = parentLink.href;
                        clicked = true;
                    }
                }
                
                if (clicked) {
                    console.log("Click event dispatched, waiting for page load...");
                    // Wait longer for page to load (JD pages may take time)
                    setTimeout(() => {
                        scrapeData();
                    }, 8000);
                } else {
                    console.error("All click methods failed!");
                    finishScrape(allData);
                }
            }, delay);

        } else {
            console.error("Next button not found. Available pagination elements:");
            const paginationElements = Array.from(document.querySelectorAll('.pager, .pagination, [class*="pager"], [class*="pagination"], [class*="page"]'));
            paginationElements.forEach(el => {
                console.log("Pagination element:", {
                    tag: el.tagName,
                    class: el.className,
                    text: (el.innerText || el.textContent || '').substring(0, 50),
                    html: el.outerHTML.substring(0, 200)
                });
            });
            finishScrape(allData);
        }
    } else {
        console.log("Reached page limit.");
        finishScrape(allData);
    }
}

function finishScrape(data) {
    alert(`爬取完成！共爬取 ${data.length} 个商品。\n请点击插件图标导出。`);
    chrome.runtime.sendMessage({ action: "dataScraped", data: data, platform: "jd" });
    // Do NOT reset state here to prevent race conditions.
    // State is reset by popup.js when starting a new search.
}

// Auto-run logic
// Check for JD search pages: search.jd.com, list.jd.com, or mobile pages
if (window.location.href.includes('search.jd.com') || 
    window.location.href.includes('list.jd.com') ||
    window.location.href.includes('re.m.jd.com')) {
    const btn = document.createElement('button');
    btn.innerText = "开始爬取 (JD Crawler)";
    btn.style.position = "fixed";
    btn.style.top = "120px";
    btn.style.right = "20px";
    btn.style.zIndex = "99999";
    btn.style.padding = "12px 20px";
    btn.style.backgroundColor = "#e1251b"; // JD Red
    btn.style.color = "white";
    btn.style.border = "2px solid white";
    btn.style.borderRadius = "25px";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 4px 10px rgba(0,0,0,0.2)";
    btn.style.fontWeight = "bold";

    btn.onclick = () => {
        // Reset state on manual click
        chrome.storage.local.set({ 'currentPage': 1, 'jdData': [] }, () => {
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

