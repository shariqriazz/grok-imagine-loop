document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const promptInput = document.getElementById('prompt');
    const loopsInput = document.getElementById('loops');
    const timeoutInput = document.getElementById('timeout');
    const fileInput = document.getElementById('initialImage');
    const restoredImageIndicator = document.getElementById('restoredImageIndicator');
    const restoredImageText = document.getElementById('restoredImageText');
    const restoredImagePreview = document.getElementById('restoredImagePreview');
    const clearImageBtn = document.getElementById('clearImageBtn');
    const statusDiv = document.getElementById('status');
    let storedImageData = null;

    const autoDownloadInput = document.getElementById('autoDownload');
    const upscaleInput = document.getElementById('upscale');
    const resetInputsBtn = document.getElementById('resetInputsBtn');

    // --- Persistence Logic ---

    // Load saved inputs AND image
    chrome.storage.local.get(['grokLoopInputs', 'grokLoopImage'], (result) => {
        if (result.grokLoopInputs) {
            const saved = result.grokLoopInputs;
            if (saved.prompt) promptInput.value = saved.prompt;
            if (saved.loops) loopsInput.value = saved.loops;
            if (saved.timeout) timeoutInput.value = saved.timeout;
            if (saved.upscale !== undefined) upscaleInput.checked = saved.upscale;
            if (saved.autoDownload !== undefined) autoDownloadInput.checked = saved.autoDownload;
        }
        if (result.grokLoopImage) {
            // Handle new object format vs old string format
            if (typeof result.grokLoopImage === 'string') {
                // Backward compat
                storedImageData = result.grokLoopImage;
                restoredImageText.textContent = '✓ Image Restored';
                restoredImagePreview.src = storedImageData;
            } else {
                storedImageData = result.grokLoopImage.dataUrl;
                restoredImageText.textContent = `✓ ${result.grokLoopImage.fileName}`;
                restoredImagePreview.src = storedImageData;
            }
            restoredImageIndicator.style.display = 'flex';
        }
    });

    // Image Input Handler
    fileInput.addEventListener('change', async () => {
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const dataUrl = await readFileAsDataURL(file);
            storedImageData = dataUrl;

            // Save object with filename
            chrome.storage.local.set({
                'grokLoopImage': {
                    dataUrl: dataUrl,
                    fileName: file.name
                }
            });

            restoredImageText.textContent = `✓ ${file.name}`;
            restoredImagePreview.src = dataUrl;
            restoredImageIndicator.style.display = 'flex';
        }
    });

    // Clear Image Handler
    clearImageBtn.addEventListener('click', () => {
        storedImageData = null;
        fileInput.value = ''; // Reset file input
        restoredImagePreview.src = '';
        chrome.storage.local.remove('grokLoopImage');
        restoredImageIndicator.style.display = 'none';
    });

    // Save inputs handler
    const saveInputs = () => {
        const inputs = {
            prompt: promptInput.value,
            loops: loopsInput.value,
            timeout: timeoutInput.value,
            upscale: upscaleInput.checked,
            autoDownload: autoDownloadInput.checked
        };
        chrome.storage.local.set({ 'grokLoopInputs': inputs });
    };

    // Attach listeners
    [promptInput, loopsInput, timeoutInput, upscaleInput, autoDownloadInput].forEach(el => {
        el.addEventListener('input', saveInputs);
        el.addEventListener('change', saveInputs);
    });

    // Reset handler
    resetInputsBtn.addEventListener('click', () => {
        if (confirm('Reset all inputs and images to default?')) {
            promptInput.value = '';
            loopsInput.value = '3';
            timeoutInput.value = '120';
            upscaleInput.checked = false;
            autoDownloadInput.checked = false;

            // Clear image
            storedImageData = null;
            fileInput.value = '';
            restoredImageIndicator.style.display = 'none';
            chrome.storage.local.remove(['grokLoopInputs', 'grokLoopImage']);
        }
    });

    // Auto-populate loops based on lines (and save)
    promptInput.addEventListener('input', () => {
        const lines = promptInput.value.split('\n').filter(p => p.trim() !== '').length;
        if (lines > 0) {
            loopsInput.value = lines;
            saveInputs();
        }
    });

    // --- Helper Functions ---

    function readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function sendMessageWithRetry(tabId, message, attempt = 1) {
        console.log(`[Popup] Attempt ${attempt}: Sending message to tab ${tabId}`, message);
        statusDiv.innerText = `Attempt ${attempt}: Connecting...`;

        try {
            const response = await chrome.tabs.sendMessage(tabId, message).catch(err => {
                if (chrome.runtime.lastError) throw chrome.runtime.lastError;
                throw err;
            });

            console.log('[Popup] Success response:', response);
            statusDiv.innerText = 'Process started! Check the page.';

        } catch (error) {
            console.warn(`[Popup] Attempt ${attempt} failed:`, error);
            const errorMsg = error.message || "Unknown error";

            if (errorMsg.includes("Receiving end does not exist")) {
                if (attempt === 1) {
                    statusDiv.innerText = 'Injecting script...';

                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            files: ['content/content.js']
                        });

                        await chrome.scripting.insertCSS({
                            target: { tabId: tabId },
                            files: ['content/styles.css']
                        });

                        console.log('[Popup] Injection successful. Retrying message...');
                        statusDiv.innerText = 'Script injected. Retrying...';

                        // Wait for script to initialize
                        await new Promise(r => setTimeout(r, 1000));

                        // Retry
                        await sendMessageWithRetry(tabId, message, 2);

                    } catch (injectionError) {
                        console.error('[Popup] Injection failed:', injectionError);
                        statusDiv.innerText = 'Injection failed: ' + injectionError.message;
                    }
                    return;
                }
            }
            statusDiv.innerText = 'Error: ' + errorMsg;
        }
    }

    const popOutBtn = document.getElementById('popOutBtn');

    // --- Tab Finding Helper ---
    async function findGrokTab() {
        // 1. Try active tab in current window (Standard Popup)
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        const isGrok = (t) => t && (t.url.includes('grok.com') || t.url.includes('x.com') || t.url.includes('twitter.com'));

        if (isGrok(tab)) return tab;

        // 2. If we are detached, find the most relevant Grok tab
        console.log("Current tab is not Grok. Searching all windows...");
        const tabs = await chrome.tabs.query({ url: ["*://grok.com/*", "*://x.com/*", "*://twitter.com/*"] });

        // Prefer active tabs in other windows
        const activeGrok = tabs.find(t => t.active);
        return activeGrok || tabs[0];
    }

    // --- Pop Out Logic ---
    if (popOutBtn) {
        popOutBtn.addEventListener('click', () => {
            chrome.windows.create({
                url: chrome.runtime.getURL("popup/popup.html"),
                type: "popup",
                width: 360,
                height: 650
            });
            window.close(); // Close the standard popup
        });
    }

    // --- Resume Logic ---

    chrome.storage.local.get(['grokLoopState'], (result) => {
        if (result.grokLoopState) {
            resumeBtn.style.display = 'block';
            resumeBtn.innerText = `Resume (Segment ${result.grokLoopState.currentSegmentIndex + 1})`;

            resumeBtn.onclick = async () => {
                const tab = await findGrokTab();
                if (!tab) {
                    statusDiv.innerText = 'Error: No Grok tab found.';
                    return;
                }

                await sendMessageWithRetry(tab.id, {
                    action: 'RESTORE_LOOP',
                    payload: result.grokLoopState
                });
            };
        }
    });

    // --- Start Button Logic ---

    startBtn.addEventListener('click', async () => {
        const promptSequence = promptInput.value.split('\n').filter(p => p.trim() !== '');
        const loops = parseInt(loopsInput.value, 10);
        const timeout = parseInt(timeoutInput.value, 10) || 30;

        if (promptSequence.length === 0) {
            statusDiv.innerText = 'Error: Please enter at least one prompt.';
            return;
        }

        let initialImageData = null;
        if (fileInput.files.length > 0) {
            initialImageData = await readFileAsDataURL(fileInput.files[0]);
        } else if (storedImageData) {
            initialImageData = storedImageData;
        }

        // Get active tab
        const tab = await findGrokTab();

        if (!tab) {
            statusDiv.innerText = 'Error: No active Grok tab found.';
            return;
        }

        // URL Checks
        const url = tab.url || '';
        const isSupported = url.includes('x.com') || url.includes('twitter.com') || url.includes('grok.com');
        const isConfig = url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:');

        if (isConfig || !isSupported) {
            statusDiv.innerText = 'You are not on Grok. Click below to launch it.';
            startBtn.innerText = 'Go to grok.com';
            startBtn.onclick = () => {
                chrome.tabs.update(tab.id, { url: 'https://grok.com' });
                window.close();
            };
            return;
        }

        const upscale = document.getElementById('upscale').checked;
        const autoDownload = document.getElementById('autoDownload').checked;

        // Send 'START_LOOP'
        await sendMessageWithRetry(tab.id, {
            action: 'START_LOOP',
            payload: {
                prompts: promptSequence,
                loops: loops,
                initialImage: initialImageData,
                timeout: timeout,
                upscale: upscale,
                autoDownload: autoDownload
            }
        });
    });

    // About / Ko-Fi Link
    document.getElementById('kofiBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://ko-fi.com/mrdom78' });
    });

    document.getElementById('githubBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://github.com/allophylus/grok-imagine-loop' });
    });
});
