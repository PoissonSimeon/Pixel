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
const COOLDOWN_MS = 100; // 0.1 seconde
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

                if (now - lastAction < COOLDOWN_MS) {
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Veuillez patienter.' }));
                }

                const x = Math.floor(data.x);
                const y = Math.floor(data.y);
                const color = data.color;

                if (isNaN(x) || isNaN(y) || x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) return;
                if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

                const { r, g, b } = hexToRgb(color);
                const idx = (y * BOARD_WIDTH + x) * 3;
                board[idx] = r;
                board[idx + 1] = g;
                board[idx + 2] = b;

                cooldowns.set(ip, now);

                const broadcastMsg = JSON.stringify({ type: 'pixel', x, y, color });
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
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
        canvas { display: block; touch-action: none; cursor: crosshair; }
        
        #ui { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 20, 0.85); padding: 12px 25px; border-radius: 40px; display: flex; gap: 20px; align-items: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); z-index: 10; }
        
        .tools { display: flex; gap: 10px; border-right: 1px solid rgba(255,255,255,0.2); padding-right: 20px; }
        .tool-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: all 0.2s; outline: none; padding: 0; }
        .tool-btn:hover { background: rgba(255,255,255,0.2); }
        .tool-btn.active { background: rgba(76, 175, 80, 0.5); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.5); }

        #color-btn-indicator { width: 45px; height: 45px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.5); cursor: pointer; box-shadow: 0 0 10px rgba(0,0,0,0.3); transition: transform 0.1s; }
        #color-btn-indicator:hover { transform: scale(1.1); border-color: white; }

        #colorPanel { display: none; position: absolute; bottom: 95px; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 20, 0.95); padding: 20px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(15px); flex-direction: column; align-items: center; gap: 15px; box-shadow: 0 15px 40px rgba(0,0,0,0.6); z-index: 10; }
        #hexInput { width: 90px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 16px; font-weight: bold; text-transform: uppercase; outline: none; border-radius: 8px; padding: 8px; text-align: center; }

        #exportBtn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: background 0.2s; outline: none; padding: 0; }
        #exportBtn:hover { background: rgba(255,255,255,0.2); }

        .info-block { display: flex; flex-direction: column; color: #fff; }
        .info-label { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
        .info-value { font-size: 16px; font-weight: bold; }
        
        #top-info { position: absolute; top: 15px; right: 15px; background: rgba(20, 20, 20, 0.85); padding: 8px 15px; border-radius: 20px; color: #fff; font-size: 13px; font-weight: bold; display: flex; gap: 15px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); pointer-events: none; z-index: 10; }
        .online-dot { color: #4caf50; }

        /* UI de la barre de Zoom */
        #zoom-container { position: absolute; bottom: 30px; left: 30px; background: rgba(20, 20, 20, 0.85); padding: 12px 20px; border-radius: 40px; display: flex; align-items: center; gap: 15px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); color: white; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 10; }
        .zoom-icon { font-size: 18px; cursor: pointer; user-select: none; transition: transform 0.1s; }
        .zoom-icon:hover { transform: scale(1.2); }
        #zoomSlider { cursor: pointer; width: 120px; accent-color: #4caf50; }
    </style>
</head>
<body>
    <canvas id="viewCanvas"></canvas>
    
    <div id="top-info">
        <span>X: <span id="valX">0</span> Y: <span id="valY">0</span></span>
        <span><span class="online-dot">●</span> <span id="onlineCount">1</span> en ligne</span>
    </div>

    <!-- Interface du Zoom à gauche -->
    <div id="zoom-container">
        <span class="zoom-icon" id="zoomOutBtn" title="Dézoom max">➖</span>
        <input type="range" id="zoomSlider" min="0.1" max="30" step="0.1" value="1">
        <span class="zoom-icon" id="zoomInBtn" title="Zoom max">➕</span>
    </div>

    <!-- Menu flottant Roue des Couleurs -->
    <div id="colorPanel">
        <div id="colorPickerWheel"></div>
        <input type="text" id="hexInput" value="#ff0000" maxlength="7">
    </div>

    <div id="ui">
        <div class="tools">
            <button id="btnBrush" class="tool-btn active" title="Pinceau">🖌️</button>
            <button id="btnPipette" class="tool-btn" title="Pipette">💧</button>
        </div>
        
        <!-- Bouton de couleur principal -->
        <div id="color-btn-indicator" style="background-color: #ff0000;" title="Choisir une couleur"></div>
        
        <button id="exportBtn" title="Exporter la toile en PNG">💾</button>
        <div class="info-block">
            <span class="info-label">État</span>
            <span class="info-value" id="status">Connexion...</span>
        </div>
    </div>

    <script>
        const canvas = document.getElementById('viewCanvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        
        const btnBrush = document.getElementById('btnBrush');
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

        const SIZE = 1000;
        let scale = 1;
        let offsetX = 0;
        let offsetY = 0;
        let isReady = false;
        let lastClickTime = 0;

        const offCanvas = document.createElement('canvas');
        offCanvas.width = SIZE;
        offCanvas.height = SIZE;
        const offCtx = offCanvas.getContext('2d', { alpha: false });

        let isDragging = false;
        let lastMouseX = 0;
        let lastMouseY = 0;
        let isMoved = false;
        let currentTool = 'brush'; 
        let currentColor = '#ff0000';
        
        let pendingQueue = []; 
        let lastSendTime = 0;

        // --- GESTION DES COULEURS (Roue iro.js) ---
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

        // Afficher / Cacher le panneau des couleurs
        colorBtnIndicator.addEventListener('click', () => {
            colorPanel.style.display = colorPanel.style.display === 'flex' ? 'none' : 'flex';
        });

        // Fermer le panneau si on clique ailleurs sur la toile
        canvas.addEventListener('mousedown', () => {
            if (colorPanel.style.display === 'flex') colorPanel.style.display = 'none';
        });

        // --- GESTION DES OUTILS ---
        btnBrush.addEventListener('click', () => { currentTool = 'brush'; btnBrush.classList.add('active'); btnPipette.classList.remove('active'); canvas.style.cursor = 'crosshair'; });
        btnPipette.addEventListener('click', () => { currentTool = 'pipette'; btnPipette.classList.add('active'); btnBrush.classList.remove('active'); canvas.style.cursor = 'crosshair'; });

        canvas.addEventListener('contextmenu', e => e.preventDefault());

        // --- GESTION DU ZOOM ---
        function applyZoom(newScale, centerOnScreen = false, targetX = 0, targetY = 0) {
            newScale = Math.max(0.1, Math.min(newScale, 30));
            const actualZoomFactor = newScale / scale;
            
            if (centerOnScreen) {
                targetX = window.innerWidth / 2;
                targetY = window.innerHeight / 2;
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
            applyZoom(scale * zoomFactor, false, e.clientX, e.clientY);
        }, {passive: false});

        // --- NAVIGATION ET DESSIN ---
        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            if(scale === 1 && offsetX === 0 && offsetY === 0) {
                scale = Math.min(window.innerWidth / SIZE, window.innerHeight / SIZE) * 0.9;
                offsetX = (window.innerWidth - (SIZE * scale)) / 2;
                offsetY = (window.innerHeight - (SIZE * scale)) / 2;
                zoomSlider.value = scale;
            }
            draw();
        }
        window.addEventListener('resize', resize);
        
        function onPointerDown(e) {
            if (e.button === 2 || e.touches) isDragging = true;
            isMoved = false;
            lastMouseX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
            lastMouseY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
        }
        function onPointerMove(e) {
            const clientX = e.clientX || (e.touches ? e.touches[0].clientX : lastMouseX);
            const clientY = e.clientY || (e.touches ? e.touches[0].clientY : lastMouseY);
            
            const bx = Math.floor((clientX - offsetX) / scale);
            const by = Math.floor((clientY - offsetY) / scale);
            if(bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                valX.innerText = bx;
                valY.innerText = by;
                
                if (e.buttons === 1 && currentTool === 'brush' && !isDragging && isReady) {
                    placePixel(bx, by);
                }
            }

            if (!isDragging) return;
            isMoved = true;

            offsetX += clientX - lastMouseX;
            offsetY += clientY - lastMouseY;
            lastMouseX = clientX;
            lastMouseY = clientY;
            draw();
        }
        function onPointerUp(e) {
            isDragging = false;
            if (e.button === 2) return;

            if (!isMoved && isReady && (e.button === 0 || e.changedTouches)) {
                const clientX = e.clientX || (e.changedTouches ? e.changedTouches[0].clientX : lastMouseX);
                const clientY = e.clientY || (e.changedTouches ? e.changedTouches[0].clientY : lastMouseY);
                
                const bx = Math.floor((clientX - offsetX) / scale);
                const by = Math.floor((clientY - offsetY) / scale);
                
                if (bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                    if (currentTool === 'brush') placePixel(bx, by);
                    else if (currentTool === 'pipette') pickColor(bx, by);
                }
            }
        }

        function pickColor(x, y) {
            // Lecture exacte du pixel sur le canvas offscreen (garantit 100% de fiabilité)
            const p = offCtx.getImageData(x, y, 1, 1).data;
            const hex = "#" + (1 << 24 | p[0] << 16 | p[1] << 8 | p[2]).toString(16).padStart(6, '0').slice(-6);
            
            updateColor(hex);
            btnBrush.click(); // Retour au pinceau
        }

        canvas.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        
        canvas.addEventListener('touchstart', onPointerDown, {passive: false});
        window.addEventListener('touchmove', onPointerMove, {passive: false});
        window.addEventListener('touchend', onPointerUp);

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
                ctx.fillRect(p.x + 0.1, p.y + 0.1, 0.8, 0.8);
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
                    const { r, g, b } = hexToRgb(data.color);
                    
                    // CORRECTION MAJEURE : Force l'écriture directe dans la mémoire GPU
                    const id = offCtx.createImageData(1, 1);
                    id.data[0] = r; id.data[1] = g; id.data[2] = b; id.data[3] = 255;
                    offCtx.putImageData(id, data.x, data.y);
                    
                    pendingQueue = pendingQueue.filter(p => !(p.x === data.x && p.y === data.y && p.color.toLowerCase() === data.color.toLowerCase()));
                    draw();
                } else if (data.type === 'error') {
                    pendingQueue.shift();
                    draw();
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
            const existing = pendingQueue.find(p => p.x === bx && p.y === by);
            
            if (existing) existing.color = currentColor;
            else pendingQueue.push({ x: bx, y: by, color: currentColor });
            
            draw();
        }

        setInterval(() => {
            const now = Date.now();
            if (pendingQueue.length > 0 && now - lastSendTime >= 110) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const p = pendingQueue[0]; 
                    ws.send(JSON.stringify({ type: 'pixel', x: p.x, y: p.y, color: p.color }));
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
