/**
 * Projet : pixel.florianscher.fr
 * Description : Serveur Node.js "Single-File" pour un mur de pixels collaboratif 1000x1000.
 * Prérequis : npm install ws
 * Exécution : node pixel.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// --- CONFIGURATION ---
const PORT = 80;
const BOARD_WIDTH = 1000;
const BOARD_HEIGHT = 1000;
const BOARD_SIZE = BOARD_WIDTH * BOARD_HEIGHT * 3; // 3 octets par pixel (RGB)
const COOLDOWN_MS = 100; // 0.1 seconde (Limite stricte serveur)
const BOARD_FILE = path.join(__dirname, 'board.dat');

// --- ÉTAT DU SERVEUR ---
let board; 
const cooldowns = new Map(); 

// --- INITIALISATION DU PLATEAU ---
try {
    if (fs.existsSync(BOARD_FILE)) {
        board = fs.readFileSync(BOARD_FILE);
        console.log(`[INIT] Plateau chargé depuis ${BOARD_FILE}`);
    } else {
        board = Buffer.alloc(BOARD_SIZE);
        board.fill(26); // Remplit avec la couleur #1a1a1a (26 en décimal) par défaut (fond sombre)
        console.log('[INIT] Nouveau plateau sombre créé.');
    }
} catch (err) {
    console.error('[ERREUR] Impossible de charger/créer le plateau :', err);
    process.exit(1);
}

// Sauvegarde automatique toutes les 60 secondes
setInterval(() => {
    fs.writeFile(BOARD_FILE, board, (err) => {
        if (err) console.error('[ERREUR] Sauvegarde du plateau échouée :', err);
    });
}, 60000);

// Nettoyage de la map des cooldowns toutes les minutes (Anti fuite de mémoire)
setInterval(() => {
    const now = Date.now();
    for (const [ip, time] of cooldowns.entries()) {
        if (now - time > COOLDOWN_MS * 2) cooldowns.delete(ip);
    }
}, 60000);

// --- FONCTIONS UTILITAIRES ---
function hexToRgb(hex) {
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
    };
}

// --- SERVEUR HTTP ---
const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FRONTEND_HTML);
        return;
    }

    if (req.method === 'GET' && req.url === '/board.dat') {
        res.writeHead(200, { 
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        res.end(board);
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

// --- SERVEUR WEBSOCKET ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

    const sendOnlineCount = () => {
        const msg = JSON.stringify({ type: 'stats', online: wss.clients.size });
        wss.clients.forEach(client => {
            if (client.readyState === ws.OPEN) client.send(msg);
        });
    };
    sendOnlineCount();

    ws.on('message', (message) => {
        if (message.length > 200) return ws.close(1009, 'Message trop lourd');

        try {
            const data = JSON.parse(message);
            
            if (data.type === 'pixel') {
                const now = Date.now();
                const lastAction = cooldowns.get(ip) || 0;

                // Vérification anti-spam
                if (now - lastAction < COOLDOWN_MS) {
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Veuillez patienter.' }));
                }

                const x = Math.floor(data.x);
                const y = Math.floor(data.y);
                const color = data.color;
                const size = parseInt(data.size) || 1;

                if (![1, 2, 4, 6, 8].includes(size)) return;
                if (isNaN(x) || isNaN(y) || x < -10 || x >= BOARD_WIDTH || y < -10 || y >= BOARD_HEIGHT) return;
                if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

                const { r, g, b } = hexToRgb(color);
                
                // Application serveur
                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        const px = x + i;
                        const py = y + j;
                        if (px >= 0 && px < BOARD_WIDTH && py >= 0 && py < BOARD_HEIGHT) {
                            const idx = (py * BOARD_WIDTH + px) * 3;
                            board[idx] = r;
                            board[idx + 1] = g;
                            board[idx + 2] = b;
                        }
                    }
                }

                cooldowns.set(ip, now);

                const broadcastMsg = JSON.stringify({ type: 'pixel', x, y, color, size });
                wss.clients.forEach(client => {
                    if (client.readyState === ws.OPEN) client.send(broadcastMsg);
                });
            }
        } catch (err) {}
    });

    ws.on('close', sendOnlineCount);
});

server.listen(PORT, () => {
    console.log(`[SERVEUR] Pixel actif sur le port ${PORT}`);
});

// ============================================================================
// ========================= FRONTEND (HTML / CSS / JS) =======================
// ============================================================================
const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pixel - florianscher.fr</title>
    <!-- Importation de la roue chromatique iro.js -->
    <script src="https://cdn.jsdelivr.net/npm/@jaames/iro@5"></script>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
        
        #app { display: flex; flex-direction: column; height: 100vh; width: 100vw; position: relative; }
        
        #canvas-wrapper { flex: 1; position: relative; overflow: hidden; background: #1a1a1a; cursor: crosshair; }
        canvas { display: block; touch-action: none; width: 100%; height: 100%; }
        
        #hud { 
            background: #1e1e1e; border-top: 1px solid #333; padding: 12px 20px; 
            display: flex; justify-content: center; align-items: center; 
            flex-wrap: wrap; gap: 25px; z-index: 20; box-shadow: 0 -5px 20px rgba(0,0,0,0.5);
        }

        .hud-group { display: flex; align-items: center; gap: 12px; }

        .tool-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: all 0.2s; outline: none; padding: 0; }
        .tool-btn:hover { background: rgba(255,255,255,0.2); }
        .tool-btn.active { background: rgba(76, 175, 80, 0.5); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.5); }
        
        #brushSize { background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 15px; font-weight: bold; outline: none; border-radius: 8px; padding: 5px 10px; cursor: pointer; height: 40px; }
        #brushSize option { background: #1a1a1a; }

        .icon-btn { font-size: 18px; cursor: pointer; transition: transform 0.1s; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; color: white;}
        .icon-btn:hover { transform: scale(1.2); }
        #zoomSlider { cursor: pointer; width: 100px; accent-color: #4caf50; }

        #color-btn-indicator { width: 45px; height: 45px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.5); cursor: pointer; box-shadow: 0 0 10px rgba(0,0,0,0.3); transition: transform 0.1s; }
        #color-btn-indicator:hover { transform: scale(1.1); border-color: white; }

        #colorPanel { display: none; position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 20, 0.95); padding: 20px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(15px); flex-direction: column; align-items: center; gap: 15px; box-shadow: 0 15px 40px rgba(0,0,0,0.8); z-index: 10; }
        #hexInput { width: 90px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 16px; font-weight: bold; text-transform: uppercase; outline: none; border-radius: 8px; padding: 8px; text-align: center; }

        .info-group { color: #fff; font-size: 13px; font-weight: bold; background: rgba(0,0,0,0.3); padding: 8px 15px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.05); display: flex; gap: 15px; }
        .info-group span { display: flex; align-items: center; gap: 5px; }
        .coords { color: #aaa; width: 90px; }
        .online-dot { color: #4caf50; font-size: 16px; }
        #status { color: #f44336; border-left: 1px solid #444; padding-left: 15px; }

        /* UI de la Barre de Progression Dynamique */
        #progress-container {
            position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(20, 20, 20, 0.9); padding: 12px 20px; border-radius: 15px;
            border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(15px);
            display: flex; flex-direction: column; gap: 8px; width: 280px; z-index: 30;
            box-shadow: 0 15px 40px rgba(0,0,0,0.6);
            opacity: 0; pointer-events: none; transition: opacity 0.3s ease;
        }
        #progress-container.show { opacity: 1; }
        .progress-info { display: flex; justify-content: space-between; color: white; font-size: 13px; font-weight: bold; }
        .progress-bar-bg { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
        #progress-bar-fill { height: 100%; width: 0%; background: #4caf50; transition: width 0.1s linear; }
    </style>
</head>
<body>
    <div id="app">
        
        <!-- Jauge d'envoi dynamique -->
        <div id="progress-container">
            <div class="progress-info">
                <span id="progress-text">0%</span>
                <span id="progress-remaining">0 pixel en attente</span>
            </div>
            <div class="progress-bar-bg">
                <div id="progress-bar-fill"></div>
            </div>
        </div>

        <div id="canvas-wrapper">
            <canvas id="viewCanvas"></canvas>
            
            <div id="colorPanel">
                <div id="colorPickerWheel"></div>
                <input type="text" id="hexInput" value="#ff0000" maxlength="7">
            </div>
        </div>

        <div id="hud">
            <div class="hud-group">
                <span class="icon-btn" id="zoomOutBtn" title="Dézoom max">➖</span>
                <input type="range" id="zoomSlider" min="0.1" max="30" step="0.1" value="1">
                <span class="icon-btn" id="zoomInBtn" title="Zoom max">➕</span>
            </div>

            <div class="hud-group">
                <button id="btnBrush" class="tool-btn active" title="Pinceau">🖌️</button>
                <select id="brushSize" title="Taille du pinceau">
                    <option value="1">1x1</option>
                    <option value="2">2x2</option>
                    <option value="4">4x4</option>
                    <option value="6">6x6</option>
                    <option value="8">8x8</option>
                </select>
                <button id="btnPipette" class="tool-btn" title="Pipette">💧</button>
                <div id="color-btn-indicator" style="background-color: #ff0000;" title="Choisir une couleur"></div>
                <button id="exportBtn" class="tool-btn" title="Exporter la toile en PNG">💾</button>
            </div>

            <div class="hud-group info-group">
                <span class="coords">X:<span id="valX">0</span> Y:<span id="valY">0</span></span>
                <span><span class="online-dot">●</span> <span id="onlineCount">1</span> en ligne</span>
                <span id="status">Connexion...</span>
            </div>
        </div>
    </div>

    <script>
        const canvas = document.getElementById('viewCanvas');
        const wrapper = document.getElementById('canvas-wrapper');
        const ctx = canvas.getContext('2d', { alpha: false });
        
        const btnBrush = document.getElementById('btnBrush');
        const brushSizeSelect = document.getElementById('brushSize');
        const btnPipette = document.getElementById('btnPipette');
        const colorBtnIndicator = document.getElementById('color-btn-indicator');
        const colorPanel = document.getElementById('colorPanel');
        const hexInput = document.getElementById('hexInput');
        
        const zoomSlider = document.getElementById('zoomSlider');
        const zoomOutBtn = document.getElementById('zoomOutBtn');
        const zoomInBtn = document.getElementById('zoomInBtn');

        const statusEl = document.getElementById('status');
        const valX = document.getElementById('valX');
        const valY = document.getElementById('valY');
        const onlineCount = document.getElementById('onlineCount');
        const exportBtn = document.getElementById('exportBtn');

        // Variables Jauge de Progression
        const progressContainer = document.getElementById('progress-container');
        const progressBarFill = document.getElementById('progress-bar-fill');
        const progressText = document.getElementById('progress-text');
        const progressRemaining = document.getElementById('progress-remaining');

        const SIZE = 1000;
        let scale = 1;
        let offsetX = 0;
        let offsetY = 0;
        let isReady = false;

        const offCanvas = document.createElement('canvas');
        offCanvas.width = SIZE;
        offCanvas.height = SIZE;
        const offCtx = offCanvas.getContext('2d', { alpha: false });

        let isPanning = false;
        let isPainting = false;
        let isMoved = false;
        let lastMouseX = 0;
        let lastMouseY = 0;
        
        let currentTool = 'brush'; 
        let currentColor = '#ff0000';
        let currentSize = 1;
        let pendingQueue = []; 
        let lastSendTime = 0;
        let hoverX = -1;
        let hoverY = -1;

        let totalPendingBatch = 0;
        let progressHideTimeout;

        // --- GESTION DES COULEURS ---
        var colorPicker = new iro.ColorPicker("#colorPickerWheel", {
            width: 150,
            color: currentColor,
            borderWidth: 2,
            borderColor: "#ffffff",
            layout: [
                { component: iro.ui.Wheel },
                { component: iro.ui.Slider, options: { sliderType: 'value' } }
            ]
        });

        function hexToRgbClient(hex) {
            return {
                r: parseInt(hex.slice(1, 3), 16),
                g: parseInt(hex.slice(3, 5), 16),
                b: parseInt(hex.slice(5, 7), 16)
            };
        }

        function updateColor(hex) {
            currentColor = hex;
            colorBtnIndicator.style.backgroundColor = hex;
            hexInput.value = hex;
            colorPicker.color.hexString = hex;
        }

        colorPicker.on('color:change', function(color) {
            currentColor = color.hexString;
            colorBtnIndicator.style.backgroundColor = currentColor;
            hexInput.value = currentColor;
        });

        hexInput.addEventListener('input', (e) => {
            let val = e.target.value;
            if (!val.startsWith('#')) val = '#' + val;
            if (/^#[0-9a-fA-F]{6}$/.test(val)) updateColor(val);
        });

        brushSizeSelect.addEventListener('change', (e) => currentSize = parseInt(e.target.value));

        colorBtnIndicator.addEventListener('click', () => {
            colorPanel.style.display = colorPanel.style.display === 'flex' ? 'none' : 'flex';
        });

        canvas.addEventListener('mousedown', () => {
            if (colorPanel.style.display === 'flex') colorPanel.style.display = 'none';
        });

        // --- GESTION DES OUTILS ---
        btnBrush.addEventListener('click', () => { currentTool = 'brush'; btnBrush.classList.add('active'); btnPipette.classList.remove('active'); wrapper.style.cursor = 'crosshair'; });
        btnPipette.addEventListener('click', () => { currentTool = 'pipette'; btnPipette.classList.add('active'); btnBrush.classList.remove('active'); wrapper.style.cursor = 'crosshair'; });

        canvas.addEventListener('contextmenu', e => e.preventDefault());

        // --- GESTION DE LA JAUGE ---
        function updateProgressBar() {
            if (pendingQueue.length === 0) {
                progressBarFill.style.width = '100%';
                progressText.innerText = '100%';
                progressRemaining.innerText = '0 restant';
                
                clearTimeout(progressHideTimeout);
                progressHideTimeout = setTimeout(() => {
                    if (pendingQueue.length === 0) {
                        progressContainer.classList.remove('show');
                        totalPendingBatch = 0;
                    }
                }, 1000);
            } else {
                clearTimeout(progressHideTimeout);
                progressContainer.classList.add('show');
                
                // Sécurité pour ne pas diviser par zéro ou avoir un pourcentage négatif
                if (totalPendingBatch < pendingQueue.length) totalPendingBatch = pendingQueue.length;
                
                const sent = totalPendingBatch - pendingQueue.length;
                const percent = totalPendingBatch === 0 ? 0 : Math.floor((sent / totalPendingBatch) * 100);
                
                progressBarFill.style.width = percent + '%';
                progressText.innerText = percent + '%';
                progressRemaining.innerText = pendingQueue.length + (pendingQueue.length > 1 ? ' restants' : ' restant');
            }
        }

        // --- GESTION DU ZOOM ---
        function applyZoom(newScale, centerOnScreen = false, targetX = 0, targetY = 0) {
            newScale = Math.max(0.1, Math.min(newScale, 30));
            const actualZoomFactor = newScale / scale;
            
            if (centerOnScreen) {
                targetX = canvas.width / 2;
                targetY = canvas.height / 2;
            }
            
            offsetX = targetX - (targetX - offsetX) * actualZoomFactor;
            offsetY = targetY - (targetY - offsetY) * actualZoomFactor;
            scale = newScale;
            
            zoomSlider.value = scale;
            draw();
        }

        zoomSlider.addEventListener('input', (e) => applyZoom(parseFloat(e.target.value), true));
        zoomOutBtn.addEventListener('click', () => applyZoom(0.1, true));
        zoomInBtn.addEventListener('click', () => applyZoom(30, true));

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSpeed = 0.002;
            const zoomFactor = Math.exp(e.deltaY * -zoomSpeed);
            const pos = getEventData(e);
            applyZoom(scale * zoomFactor, false, pos.canvasX, pos.canvasY);
        }, {passive: false});

        // --- NAVIGATION ET DESSIN ---
        function resize() {
            canvas.width = wrapper.clientWidth;
            canvas.height = wrapper.clientHeight;
            if(scale === 1 && offsetX === 0 && offsetY === 0) {
                scale = Math.min(canvas.width / SIZE, canvas.height / SIZE) * 0.9;
                offsetX = (canvas.width - (SIZE * scale)) / 2;
                offsetY = (canvas.height - (SIZE * scale)) / 2;
                zoomSlider.value = scale;
            }
            draw();
        }
        window.addEventListener('resize', resize);
        
        function getEventData(e) {
            let cx = 0, cy = 0;
            if (e.touches && e.touches.length > 0) {
                cx = e.touches[0].clientX; cy = e.touches[0].clientY;
            } else if (e.changedTouches && e.changedTouches.length > 0) {
                cx = e.changedTouches[0].clientX; cy = e.changedTouches[0].clientY;
            } else {
                cx = e.clientX; cy = e.clientY;
            }
            const rect = canvas.getBoundingClientRect();
            return {
                screenX: cx, screenY: cy,
                canvasX: cx - rect.left, canvasY: cy - rect.top
            };
        }

        function triggerTool(cx, cy) {
            const bx = Math.floor((cx - offsetX) / scale);
            const by = Math.floor((cy - offsetY) / scale);
            if(bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                if (currentTool === 'brush') placePixel(bx, by);
                else if (currentTool === 'pipette') pickColor(bx, by);
            }
        }

        canvas.addEventListener('mousedown', (e) => {
            const pos = getEventData(e);
            lastMouseX = pos.screenX; lastMouseY = pos.screenY;
            isMoved = false;
            
            if (e.button === 2) isPanning = true;
            else if (e.button === 0) {
                isPainting = true;
                triggerTool(pos.canvasX, pos.canvasY);
            }
        });

        canvas.addEventListener('touchstart', (e) => {
            const pos = getEventData(e);
            lastMouseX = pos.screenX; lastMouseY = pos.screenY;
            isMoved = false;
            isPanning = true; 
        }, {passive: false});

        function handleMove(e) {
            const pos = getEventData(e);
            
            if (e.target === canvas) {
                const bx = Math.floor((pos.canvasX - offsetX) / scale);
                const by = Math.floor((pos.canvasY - offsetY) / scale);
                if(bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                    valX.innerText = bx;
                    valY.innerText = by;
                    hoverX = bx;
                    hoverY = by;
                } else {
                    hoverX = -1;
                    hoverY = -1;
                }
            }

            if (isPanning) {
                isMoved = true;
                offsetX += pos.screenX - lastMouseX;
                offsetY += pos.screenY - lastMouseY;
                draw();
            } else if (isPainting && currentTool === 'brush') {
                triggerTool(pos.canvasX, pos.canvasY);
            }
            
            lastMouseX = pos.screenX; lastMouseY = pos.screenY;
        }

        window.addEventListener('mousemove', handleMove);
        window.addEventListener('touchmove', handleMove, {passive: false});

        window.addEventListener('mouseup', () => {
            isPanning = false; isPainting = false;
        });

        canvas.addEventListener('mouseleave', () => {
            hoverX = -1; hoverY = -1; draw();
        });

        window.addEventListener('touchend', (e) => {
            if (isPanning && !isMoved && e.target === canvas) {
                const pos = getEventData(e);
                triggerTool(pos.canvasX, pos.canvasY);
            }
            isPanning = false; isPainting = false;
        });

        function pickColor(x, y) {
            const p = offCtx.getImageData(x, y, 1, 1).data;
            const hex = "#" + (1 << 24 | p[0] << 16 | p[1] << 8 | p[2]).toString(16).padStart(6, '0').slice(-6);
            updateColor(hex);
            btnBrush.click();
        }

        // --- MOTEUR DE RENDU ---
        function draw() {
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            ctx.save();
            ctx.translate(offsetX, offsetY);
            ctx.scale(scale, scale);
            
            ctx.imageSmoothingEnabled = false; 
            ctx.drawImage(offCanvas, 0, 0);

            for (const p of pendingQueue) {
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x + 0.1, p.y + 0.1, p.size - 0.2, p.size - 0.2);
            }

            if (hoverX >= 0 && currentTool === 'brush' && !isPanning) {
                const offset = Math.floor(currentSize / 2);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                ctx.lineWidth = 1 / scale; 
                ctx.strokeRect(hoverX - offset, hoverY - offset, currentSize, currentSize);
            }
            
            ctx.restore();
        }

        // --- WEBSOCKET ET API ---
        let ws;
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.type === 'pixel') {
                    const dataSize = data.size || 1;
                    offCtx.fillStyle = data.color;
                    offCtx.fillRect(data.x, data.y, dataSize, dataSize);
                    
                    const lenBefore = pendingQueue.length;
                    pendingQueue = pendingQueue.filter(p => !(p.x === data.x && p.y === data.y && p.size === dataSize));
                    
                    if (pendingQueue.length !== lenBefore) {
                        draw();
                        updateProgressBar();
                    }
                } else if (data.type === 'error') {
                    // Les erreurs réseau sont silencieusement gérées par le client
                } else if (data.type === 'stats') {
                    onlineCount.innerText = data.online;
                }
            };

            ws.onclose = () => {
                statusEl.innerText = "Déconnecté. Reconnexion...";
                statusEl.style.color = "#f44336";
                setTimeout(connectWebSocket, 2000);
            };
        }

        function placePixel(bx, by) {
            if (pendingQueue.length > 500) return;
            
            // Si la file était vide, on initialise un nouveau lot
            if (pendingQueue.length === 0) totalPendingBatch = 0;
            
            const offset = Math.floor(currentSize / 2);
            const startX = bx - offset;
            const startY = by - offset;

            // --- OPTIMISATION : Ne pas envoyer si la couleur est déjà la bonne ---
            const targetRgb = hexToRgbClient(currentColor);
            let allMatch = true;
            
            const checkX = Math.max(0, startX);
            const checkY = Math.max(0, startY);
            const checkW = Math.min(startX + currentSize, SIZE) - checkX;
            const checkH = Math.min(startY + currentSize, SIZE) - checkY;

            if (checkW > 0 && checkH > 0) {
                const imgData = offCtx.getImageData(checkX, checkY, checkW, checkH).data;
                for (let i = 0; i < imgData.length; i += 4) {
                    if (imgData[i] !== targetRgb.r || imgData[i+1] !== targetRgb.g || imgData[i+2] !== targetRgb.b) {
                        allMatch = false;
                        break;
                    }
                }
            }

            if (allMatch) {
                // Si la toile a déjà cette couleur, on nettoie d'éventuels ordres en attente contradictoires
                const lenBefore = pendingQueue.length;
                pendingQueue = pendingQueue.filter(p => !(p.x === startX && p.y === startY && p.size === currentSize));
                if (pendingQueue.length !== lenBefore) {
                    draw();
                    updateProgressBar();
                }
                return;
            }
            // ----------------------------------------------------------------------

            const existing = pendingQueue.find(p => p.x === startX && p.y === startY && p.size === currentSize);
            
            if (existing) {
                existing.color = currentColor;
                existing.retries = 0;
            } else {
                pendingQueue.push({ x: startX, y: startY, color: currentColor, size: currentSize, retries: 0 });
                totalPendingBatch++; // On augmente la taille totale du lot
            }
            draw();
            updateProgressBar();
        }

        setInterval(() => {
            const now = Date.now();
            if (pendingQueue.length > 0 && now - lastSendTime >= 130) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const p = pendingQueue[0]; 
                    p.retries = (p.retries || 0) + 1;

                    if (p.retries > 20) {
                        pendingQueue.shift();
                        draw();
                        updateProgressBar(); // Mise à jour si on abandonne un point
                        return;
                    }

                    ws.send(JSON.stringify({ type: 'pixel', x: p.x, y: p.y, color: p.color, size: p.size }));
                    lastSendTime = now;
                }
            }
        }, 10);

        exportBtn.addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = 'pixel_florianscher_fr.png';
            link.href = offCanvas.toDataURL('image/png');
            link.click();
        });

        // --- DÉMARRAGE ---
        fetch('/board.dat')
            .then(res => res.arrayBuffer())
            .then(buffer => {
                const view = new Uint8Array(buffer);
                const imgData = offCtx.createImageData(SIZE, SIZE);
                
                for (let i = 0, j = 0; i < view.length; i += 3, j += 4) {
                    imgData.data[j]     = view[i];     
                    imgData.data[j + 1] = view[i + 1]; 
                    imgData.data[j + 2] = view[i + 2]; 
                    imgData.data[j + 3] = 255;         
                }
                
                offCtx.putImageData(imgData, 0, 0);
                
                isReady = true;
                statusEl.innerText = "Prêt à peindre";
                statusEl.style.color = "#4caf50";
                
                resize();
                connectWebSocket();
            })
            .catch(err => {
                statusEl.innerText = "Erreur de chargement";
                statusEl.style.color = "#f44336";
            });
    </script>
</body>
</html>
`;
