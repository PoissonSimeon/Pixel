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
const BOARD_SIZE = BOARD_WIDTH * BOARD_HEIGHT * 3; 
const COOLDOWN_MS = 100; 
const BOARD_FILE = path.join(__dirname, 'board.dat');

// --- ÉTAT DU SERVEUR ET SÉCURITÉ ANTI-BOT ---
let board; 
const cooldowns = new Map(); 
const energyMap = new Map(); 
const activeIps = new Set(); 
const patternMap = new Map(); 

const MAX_ENERGY = 800;       
const REGEN_PER_SEC = 10;     

// --- INITIALISATION DU PLATEAU ---
try {
    if (fs.existsSync(BOARD_FILE)) {
        board = fs.readFileSync(BOARD_FILE);
        console.log(`[INIT] Plateau chargé depuis ${BOARD_FILE}`);
    } else {
        board = Buffer.alloc(BOARD_SIZE);
        board.fill(26); 
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

// Nettoyage de la mémoire
setInterval(() => {
    const now = Date.now();
    for (const [ip, time] of cooldowns.entries()) {
        if (now > time + 10000) cooldowns.delete(ip);
    }
    for (const [ip, data] of energyMap.entries()) {
        if (now - data.lastUpdate > 120000) {
            energyMap.delete(ip);
            activeIps.delete(ip);
            patternMap.delete(ip);
        }
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
    // SÉCURITÉ : Récupération IP via Cloudflare en priorité
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    ws.clientId = Math.random().toString(36).substring(2, 9); 
    ws.ip = ip; 

    // SÉCURITÉ : Limite stricte de 254 WebSockets par adresse IP
    let connectionsFromIp = 0;
    for (const client of wss.clients) {
        if (client.ip === ip) connectionsFromIp++;
    }
    if (connectionsFromIp > 254) {
        ws.close(1008, 'Too many connections');
        return; 
    }
    
    ws.sessionKey = Math.floor(Math.random() * 1000000);
    ws.send(JSON.stringify({ type: 'auth', key: ws.sessionKey }));

    const sendOnlineCount = () => {
        const msg = JSON.stringify({ type: 'stats', online: wss.clients.size });
        wss.clients.forEach(client => {
            if (client.readyState === ws.OPEN) client.send(msg);
        });
    };
    sendOnlineCount();

    ws.on('message', (message) => {
        if (message.length > 1024) return ws.close(1009, 'Message trop lourd');

        try {
            const data = JSON.parse(message);
            
            if (data.type === 'cursor') {
                activeIps.add(ip); 
                
                // SÉCURITÉ : Troncature de l'emoji à 2 caractères maximum (Anti-Spam Visuel)
                let safeEmoji = '👽';
                if (data.emoji && typeof data.emoji === 'string') {
                    safeEmoji = Array.from(data.emoji).slice(0, 2).join(''); 
                }

                const broadcastMsg = JSON.stringify({ type: 'cursor', id: ws.clientId, x: data.x, y: data.y, emoji: safeEmoji });
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === ws.OPEN) client.send(broadcastMsg);
                });
                return;
            }

            if (data.type === 'pixel') {
                const now = Date.now();

                const expectedToken = (Math.floor(data.x) * 7) + (Math.floor(data.y) * 3) + ws.sessionKey;
                if (data.token !== expectedToken) {
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Client non officiel détecté.' }));
                }

                if (!activeIps.has(ip)) {
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Veuillez bouger votre curseur avant de peindre.' }));
                }

                const nextAllowed = cooldowns.get(ip) || 0;
                if (now < nextAllowed) {
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Trop rapide.' }));
                }

                const x = Math.floor(data.x);
                const y = Math.floor(data.y);
                const color = data.color;
                const shape = data.shape;

                if (isNaN(x) || isNaN(y) || x < -10 || x >= BOARD_WIDTH || y < -10 || y >= BOARD_HEIGHT) return;
                if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

                const pixelCount = (shape && Array.isArray(shape)) ? shape.length : 1;
                if (pixelCount > 100) return;

                let pData = patternMap.get(ip);
                if (!pData) { pData = { history: [], warnings: 0 }; patternMap.set(ip, pData); }
                
                if (pixelCount === 1) {
                    pData.history.push({x, y});
                    if (pData.history.length > 12) {
                        pData.history.shift();
                        let isRaster = true;
                        for (let i = 1; i < 12; i++) {
                            const prev = pData.history[i-1];
                            const curr = pData.history[i];
                            const dx = curr.x - prev.x;
                            const dy = curr.y - prev.y;
                            
                            const isStrictStep = (Math.abs(dx) === 1 && dy === 0) || (Math.abs(dy) === 1 && Math.abs(dx) > 2);
                            if (!isStrictStep) {
                                isRaster = false; 
                                break;
                            }
                        }

                        if (isRaster) {
                            pData.warnings++;
                            pData.history = []; 
                            if (pData.warnings >= 2) {
                                energyMap.set(ip, { tokens: 0, lastUpdate: now }); 
                                cooldowns.set(ip, now + 10000); 
                                return ws.send(JSON.stringify({ type: 'error', msg: 'Bot détecté (Ligne stricte).' }));
                            }
                        } else {
                            pData.warnings = Math.max(0, pData.warnings - 0.2); 
                        }
                    }
                }

                let energyData = energyMap.get(ip);
                if (!energyData) {
                    energyData = { tokens: MAX_ENERGY, lastUpdate: now };
                    energyMap.set(ip, energyData);
                } else {
                    const elapsedSec = (now - energyData.lastUpdate) / 1000;
                    energyData.tokens = Math.min(MAX_ENERGY, energyData.tokens + (elapsedSec * REGEN_PER_SEC));
                    energyData.lastUpdate = now;
                }

                if (energyData.tokens < pixelCount) {
                    cooldowns.set(ip, now + 2000);
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Endurance épuisée.' }));
                }

                energyData.tokens -= pixelCount;
                const penalty = COOLDOWN_MS + (pixelCount * 5);
                cooldowns.set(ip, now + penalty);

                const { r, g, b } = hexToRgb(color);
                
                if (shape && Array.isArray(shape)) {
                    for (let i = 0; i < shape.length; i++) {
                        const idx = parseInt(shape[i]);
                        if (isNaN(idx) || idx < 0 || idx > 99) continue;
                        
                        const dx = (idx % 10) - 5;
                        const dy = Math.floor(idx / 10) - 5;
                        const px = x + dx;
                        const py = y + dy;
                        
                        if (px >= 0 && px < BOARD_WIDTH && py >= 0 && py < BOARD_HEIGHT) {
                            const boardIdx = (py * BOARD_WIDTH + px) * 3;
                            board[boardIdx] = r;
                            board[boardIdx + 1] = g;
                            board[boardIdx + 2] = b;
                        }
                    }
                } else {
                    if (x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT) {
                        const boardIdx = (y * BOARD_WIDTH + x) * 3;
                        board[boardIdx] = r;
                        board[boardIdx + 1] = g;
                        board[boardIdx + 2] = b;
                    }
                }

                const broadcastMsg = JSON.stringify({ type: 'pixel', x, y, color, shape });
                wss.clients.forEach(client => {
                    if (client.readyState === ws.OPEN) client.send(broadcastMsg);
                });
            }
        } catch (err) {}
    });

    ws.on('close', () => {
        const removeMsg = JSON.stringify({ type: 'cursor_remove', id: ws.clientId });
        wss.clients.forEach(client => {
            if (client.readyState === ws.OPEN) client.send(removeMsg);
        });
        sendOnlineCount();
    });
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Pixel - florianscher.fr</title>
    <script src="https://cdn.jsdelivr.net/npm/@jaames/iro@5"></script>
    <script type="module" src="https://cdn.jsdelivr.net/npm/emoji-picker-element@1/index.js"></script>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; touch-action: none; overscroll-behavior: none; }
        
        #app { display: flex; flex-direction: column; height: 100dvh; width: 100vw; position: relative; }
        
        #canvas-wrapper { flex: 1; position: relative; overflow: hidden; background: #1a1a1a; cursor: grab; }
        canvas { display: block; touch-action: none; width: 100%; height: 100%; }
        
        #hud { 
            background: #1e1e1e; border-top: 1px solid #333; padding: 12px 0; 
            width: 100%; box-sizing: border-box;
            overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;
            z-index: 20; box-shadow: 0 -5px 20px rgba(0,0,0,0.5);
        }
        #hud::-webkit-scrollbar { display: none; }
        
        .hud-inner {
            display: flex; align-items: center; gap: 20px; margin: 0 auto; width: max-content; padding: 0 15px;
        }

        .hud-group { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

        .tool-btn { 
            background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); 
            color: white; border-radius: 8px; padding: 0 16px; height: 38px; 
            cursor: pointer; display: flex; align-items: center; justify-content: center; 
            font-size: 14px; font-weight: bold; transition: all 0.2s; outline: none; flex-shrink: 0;
        }
        .tool-btn:hover { background: rgba(255,255,255,0.2); }
        .tool-btn.active { background: rgba(76, 175, 80, 0.5); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.5); }
        
        #color-btn-indicator { width: 38px; height: 38px; border-radius: 8px; border: 2px solid rgba(255,255,255,0.5); cursor: pointer; box-shadow: 0 0 10px rgba(0,0,0,0.3); transition: transform 0.1s; flex-shrink: 0; }
        #color-btn-indicator:hover { transform: scale(1.05); border-color: white; }

        .icon-btn { font-size: 18px; cursor: pointer; transition: transform 0.1s; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; color: white;}
        .icon-btn:hover { transform: scale(1.2); }
        #zoomSlider { cursor: pointer; width: 100px; accent-color: #4caf50; margin: 0 5px; }

        .floating-panel {
            display: none; position: absolute; bottom: 80px; background: rgba(20, 20, 20, 0.95); 
            padding: 20px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); 
            backdrop-filter: blur(15px); box-shadow: 0 15px 40px rgba(0,0,0,0.8); z-index: 50;
        }

        #colorPanel { left: 50%; transform: translateX(-50%); flex-direction: column; align-items: center; gap: 15px; }
        #hexInput { width: 90px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 16px; font-weight: bold; text-transform: uppercase; outline: none; border-radius: 8px; padding: 8px; text-align: center; }

        #brushPanel { left: 50%; transform: translateX(-50%); flex-direction: column; align-items: center; gap: 10px; }
        #brushEditor { display: grid; grid-template-columns: repeat(10, 1fr); width: 180px; height: 180px; background: #ccc; gap: 1px; border: 2px solid #555; cursor: crosshair; touch-action: none; border-radius: 4px; box-shadow: inset 0 0 10px rgba(0,0,0,0.5); }
        .brush-cell { background: white; width: 100%; height: 100%; user-select: none; }
        .brush-cell.active { background: black; }
        .panel-title { color: white; font-size: 13px; font-weight: bold; }

        emoji-picker {
            display: none; position: absolute; bottom: 80px; right: 20px; z-index: 50;
            --background: rgba(20, 20, 20, 0.95);
            --border-color: rgba(255,255,255,0.1);
            --input-border-color: rgba(255,255,255,0.2);
            --text-color: #fff;
            --button-hover-background: rgba(255,255,255,0.1);
            --indicator-color: #4caf50;
            box-shadow: 0 15px 40px rgba(0,0,0,0.8); border-radius: 10px;
        }

        #top-info { position: absolute; top: 15px; right: 15px; background: rgba(20, 20, 20, 0.85); padding: 8px 15px; border-radius: 20px; color: #fff; font-size: 13px; font-weight: bold; display: flex; gap: 15px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); pointer-events: none; z-index: 10; transition: color 0.3s; }
        .info-segment { display: flex; align-items: center; gap: 5px; }
        .coords { color: #aaa; width: 85px; text-align: right; }
        .online-dot { color: #4caf50; font-size: 16px; }
        #status { color: #f44336; border-left: 1px solid #444; padding-left: 15px; }

        #progress-container {
            position: absolute; top: 60px; left: 50%; transform: translateX(-50%);
            background: rgba(20, 20, 20, 0.9); padding: 12px 20px; border-radius: 15px;
            border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(15px);
            display: flex; flex-direction: column; gap: 8px; width: 280px; z-index: 30;
            box-shadow: 0 15px 40px rgba(0,0,0,0.6); opacity: 0; pointer-events: none; transition: opacity 0.3s ease;
        }
        #progress-container.show { opacity: 1; }
        .progress-info { display: flex; justify-content: space-between; color: white; font-size: 13px; font-weight: bold; }
        .progress-bar-bg { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
        #progress-bar-fill { height: 100%; width: 0%; background: #4caf50; transition: width 0.1s linear; }

        @media (max-width: 768px) {
            #top-info { top: 10px; right: 10px; left: 10px; padding: 6px 12px; font-size: 11px; justify-content: space-between; }
            #status { border: none; padding-left: 0; }
            .hide-mobile { display: none !important; }
            emoji-picker { left: 50%; transform: translateX(-50%); right: auto; width: 95vw; max-width: 350px; }
            
            /* Sur mobile, on cache les raccourcis clavier pour alléger l'interface */
            .kbd-shortcut { display: none; }
        }
    </style>
</head>
<body>
    <div id="app">
        <div id="top-info">
            <span class="info-segment coords">X:<span id="valX">0</span> Y:<span id="valY">0</span></span>
            <span class="info-segment"><span class="online-dot">●</span> <span id="onlineCount">1</span> <span class="hide-mobile">en ligne</span></span>
            <span class="info-segment" id="status">Connexion...</span>
        </div>

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
            
            <div id="colorPanel" class="floating-panel">
                <div id="colorPickerWheel"></div>
                <input type="text" id="hexInput" value="#ff0000" maxlength="7">
            </div>

            <div id="brushPanel" class="floating-panel">
                <span class="panel-title">Créer un Pinceau 10x10</span>
                <div id="brushEditor"></div>
            </div>

            <emoji-picker id="emojiPanel"></emoji-picker>
        </div>

        <div id="hud">
            <div class="hud-inner">
                <div class="hud-group hide-mobile">
                    <span class="icon-btn" id="zoomOutBtn" title="Dézoom max">➖</span>
                    <input type="range" id="zoomSlider" min="0.1" max="30" step="0.1" value="1">
                    <span class="icon-btn" id="zoomInBtn" title="Zoom max">➕</span>
                </div>

                <div class="hud-group">
                    <button id="btnBrushNormal" class="tool-btn">1x1 <span class="kbd-shortcut">&nbsp;(B)</span></button>
                    <button id="btnBrushCustom" class="tool-btn">Custom</button>
                    <button id="btnEditBrush" class="tool-btn" style="display: none;">Forme</button>

                    <button id="btnEraser" class="tool-btn">Gomme <span class="kbd-shortcut">&nbsp;(E)</span></button>
                    <div id="color-btn-indicator" style="background-color: #ff0000;"></div>
                    <button id="btnPipette" class="tool-btn">Pipette</button>
                </div>

                <div class="hud-group">
                    <button id="btnPseudo" class="tool-btn">Pseudo: 👽</button>
                    <button id="btnCursors" class="tool-btn active">Joueurs</button>
                    <button id="exportBtn" class="tool-btn">Exporter</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        const canvas = document.getElementById('viewCanvas');
        const wrapper = document.getElementById('canvas-wrapper');
        const ctx = canvas.getContext('2d', { alpha: false });
        
        const btnBrushNormal = document.getElementById('btnBrushNormal');
        const btnBrushCustom = document.getElementById('btnBrushCustom');
        const btnEditBrush = document.getElementById('btnEditBrush');
        const btnEraser = document.getElementById('btnEraser');
        
        const brushPanel = document.getElementById('brushPanel');
        const brushEditor = document.getElementById('brushEditor');

        const btnPipette = document.getElementById('btnPipette');
        const btnCursors = document.getElementById('btnCursors');
        const btnPseudo = document.getElementById('btnPseudo');
        const emojiPanel = document.getElementById('emojiPanel'); 

        const colorBtnIndicator = document.getElementById('color-btn-indicator');
        const colorPanel = document.getElementById('colorPanel');
        const hexInput = document.getElementById('hexInput');
        
        const zoomSlider = document.getElementById('zoomSlider');
        const zoomOutBtn = document.getElementById('zoomOutBtn');
        const zoomInBtn = document.getElementById('zoomInBtn');

        const statusEl = document.getElementById('status');
        const topInfoEl = document.getElementById('top-info');
        const valX = document.getElementById('valX');
        const valY = document.getElementById('valY');
        const onlineCount = document.getElementById('onlineCount');
        const exportBtn = document.getElementById('exportBtn');

        const progressContainer = document.getElementById('progress-container');
        const progressBarFill = document.getElementById('progress-bar-fill');
        const progressText = document.getElementById('progress-text');
        const progressRemaining = document.getElementById('progress-remaining');

        const SIZE = 1000;
        const DEFAULT_BG_COLOR = '#ffffff'; 
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
        let lastInputWasTouch = false; 
        
        let isPinching = false;
        let lastPinchDist = null;
        let blockDrawingUntil = 0; 

        let currentTool = 'none'; 
        let brushMode = 'normal'; 
        let currentColor = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
        
        const defaultEmojis = ['👽', '👻', '🤖', '💩', '🤡', '👾', '🐱', '🐶', '🦊', '🐵', '🐸', '🐷', '🐼', '🐻', '🦁', '🐮', '🦄', '🐔', '🐉', '🦖'];
        let myEmoji = defaultEmojis[Math.floor(Math.random() * defaultEmojis.length)];
        btnPseudo.innerText = "Pseudo: " + myEmoji;
        
        let pendingQueue = []; 
        let lastSendTime = 0;
        let hoverX = -1;
        let hoverY = -1;

        let totalPendingBatch = 0;
        let progressHideTimeout;

        let showCursors = true;
        const otherCursors = new Map(); 
        let lastCursorSendTime = 0;
        let serverSessionKey = 0; 

        function closeAllPanels() {
            colorPanel.style.display = 'none';
            brushPanel.style.display = 'none';
            emojiPanel.style.display = 'none';
        }

        btnPseudo.addEventListener('click', () => {
            const isVisible = emojiPanel.style.display === 'block'; 
            closeAllPanels();
            if (!isVisible) emojiPanel.style.display = 'block';
        });

        emojiPanel.addEventListener('emoji-click', event => {
            myEmoji = event.detail.unicode; 
            btnPseudo.innerText = "Pseudo: " + myEmoji;
            closeAllPanels();
            emitCursorPosition();
        });

        // --- RACCOURCIS CLAVIER ---
        window.addEventListener('keydown', (e) => {
            // Désactiver les raccourcis si l'utilisateur est dans un champ texte ou recherche un emoji
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'EMOJI-PICKER') return;
            
            const key = e.key.toLowerCase();
            if (key === 'b') {
                btnBrushNormal.click();
            } else if (key === 'e') {
                btnEraser.click();
            }
        });

        const customBrush = Array(100).fill(false);
        customBrush[44] = true; customBrush[45] = true; customBrush[54] = true; customBrush[55] = true;

        for(let i=0; i<100; i++) {
            const cell = document.createElement('div');
            cell.className = 'brush-cell' + (customBrush[i] ? ' active' : '');
            cell.dataset.index = i;
            brushEditor.appendChild(cell);
        }

        let isEditingBrush = false;
        let brushPaintMode = true; 

        function setBrushCell(idx, state) {
            if (idx >= 0 && idx < 100) {
                customBrush[idx] = state;
                brushEditor.children[idx].className = 'brush-cell' + (state ? ' active' : '');
            }
        }

        function handleBrushEditorInteraction(e, isTouch) {
            if (!isEditingBrush && !isTouch) return;
            const event = isTouch ? e.touches[0] : e;
            const el = document.elementFromPoint(event.clientX, event.clientY);
            if (el && el.classList.contains('brush-cell')) {
                const idx = parseInt(el.dataset.index);
                setBrushCell(idx, brushPaintMode);
            }
        }

        brushEditor.addEventListener('mousedown', (e) => {
            if(e.target.classList.contains('brush-cell')) {
                isEditingBrush = true;
                const idx = parseInt(e.target.dataset.index);
                brushPaintMode = !customBrush[idx]; 
                setBrushCell(idx, brushPaintMode);
            }
        });
        window.addEventListener('mouseup', () => { isEditingBrush = false; });
        brushEditor.addEventListener('mousemove', (e) => handleBrushEditorInteraction(e, false));

        brushEditor.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            if (el && el.classList.contains('brush-cell')) {
                isEditingBrush = true;
                const idx = parseInt(el.dataset.index);
                brushPaintMode = !customBrush[idx];
                setBrushCell(idx, brushPaintMode);
            }
        }, {passive: false});
        brushEditor.addEventListener('touchmove', (e) => {
            e.preventDefault();
            handleBrushEditorInteraction(e, true);
        }, {passive: false});
        brushEditor.addEventListener('touchend', () => { isEditingBrush = false; });

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
        
        colorBtnIndicator.style.backgroundColor = currentColor;
        hexInput.value = currentColor;

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

        colorBtnIndicator.addEventListener('click', () => {
            const isVisible = colorPanel.style.display === 'flex';
            closeAllPanels();
            if (!isVisible) colorPanel.style.display = 'flex';
        });

        function deactivateTools() {
            currentTool = 'none';
            btnBrushNormal.classList.remove('active');
            btnBrushCustom.classList.remove('active');
            btnEraser.classList.remove('active');
            btnPipette.classList.remove('active');
            wrapper.style.cursor = 'grab';
        }

        function setActiveTool(toolBtn) {
            btnBrushNormal.classList.remove('active');
            btnBrushCustom.classList.remove('active');
            btnEraser.classList.remove('active');
            btnPipette.classList.remove('active');
            toolBtn.classList.add('active');
            wrapper.style.cursor = 'crosshair';
        }

        btnBrushNormal.addEventListener('click', () => { 
            if (currentTool === 'brush' && brushMode === 'normal') {
                deactivateTools();
                btnEditBrush.style.display = 'none';
            } else {
                currentTool = 'brush'; brushMode = 'normal'; 
                setActiveTool(btnBrushNormal); 
                btnEditBrush.style.display = 'none';
            }
            closeAllPanels();
        });
        
        btnBrushCustom.addEventListener('click', () => { 
            if (currentTool === 'brush' && brushMode === 'custom') {
                deactivateTools();
                btnEditBrush.style.display = 'none';
                closeAllPanels();
            } else {
                currentTool = 'brush'; brushMode = 'custom'; 
                setActiveTool(btnBrushCustom); 
                btnEditBrush.style.display = 'flex';
                
                const isVisible = brushPanel.style.display === 'flex';
                closeAllPanels();
                if (!isVisible) brushPanel.style.display = 'flex';
            }
        });

        btnEditBrush.addEventListener('click', () => {
            const isVisible = brushPanel.style.display === 'flex';
            closeAllPanels();
            if (!isVisible) brushPanel.style.display = 'flex';
        });

        btnEraser.addEventListener('click', () => { 
            if (currentTool === 'eraser') {
                deactivateTools();
                btnEditBrush.style.display = 'none';
            } else {
                currentTool = 'eraser'; 
                setActiveTool(btnEraser); 
                if (brushMode === 'custom') {
                    btnEditBrush.style.display = 'flex';
                } else {
                    btnEditBrush.style.display = 'none';
                }
            }
            closeAllPanels();
        });

        btnPipette.addEventListener('click', () => { 
            if (currentTool === 'pipette') {
                deactivateTools();
            } else {
                currentTool = 'pipette'; 
                setActiveTool(btnPipette); 
            }
            closeAllPanels();
        });

        btnCursors.addEventListener('click', () => {
            showCursors = !showCursors;
            btnCursors.classList.toggle('active', showCursors);
            draw();
        });

        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('mousedown', closeAllPanels);
        canvas.addEventListener('touchstart', closeAllPanels, {passive: true});

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
                
                if (totalPendingBatch < pendingQueue.length) totalPendingBatch = pendingQueue.length;
                
                const sent = totalPendingBatch - pendingQueue.length;
                const percent = totalPendingBatch === 0 ? 0 : Math.floor((sent / totalPendingBatch) * 100);
                
                progressBarFill.style.width = percent + '%';
                progressText.innerText = percent + '%';
                progressRemaining.innerText = pendingQueue.length + (pendingQueue.length > 1 ? ' restants' : ' restant');
            }
        }

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
            if (zoomSlider) zoomSlider.value = scale;
            draw();
            emitCursorPosition();
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

        function resize() {
            canvas.width = wrapper.clientWidth;
            canvas.height = wrapper.clientHeight;
            if(scale === 1 && offsetX === 0 && offsetY === 0) {
                scale = Math.min(canvas.width / SIZE, canvas.height / SIZE) * 0.9;
                offsetX = (canvas.width - (SIZE * scale)) / 2;
                offsetY = (canvas.height - (SIZE * scale)) / 2;
                if (zoomSlider) zoomSlider.value = scale;
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
            if (currentTool === 'none') return;
            const bx = Math.floor((cx - offsetX) / scale);
            const by = Math.floor((cy - offsetY) / scale);
            if(bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                if (currentTool === 'brush' || currentTool === 'eraser') placePixel(bx, by);
                else if (currentTool === 'pipette') pickColor(bx, by);
            }
        }

        function emitCursorPosition() {
            const now = Date.now();
            if (now - lastCursorSendTime > 100 && ws && ws.readyState === WebSocket.OPEN) {
                let emitX = hoverX;
                let emitY = hoverY;

                if (lastInputWasTouch) {
                    const rect = canvas.getBoundingClientRect();
                    emitX = Math.floor((rect.width / 2 - offsetX) / scale);
                    emitY = Math.floor((rect.height / 2 - offsetY) / scale);
                }

                if (emitX >= 0 && emitY >= 0 && emitX < SIZE && emitY < SIZE) {
                    ws.send(JSON.stringify({ type: 'cursor', x: emitX, y: emitY, emoji: myEmoji }));
                    lastCursorSendTime = now;
                }
            }
        }

        canvas.addEventListener('mousedown', (e) => {
            lastInputWasTouch = false;
            const pos = getEventData(e);
            lastMouseX = pos.screenX; lastMouseY = pos.screenY;
            isMoved = false;
            
            if (e.button === 2 || currentTool === 'none') {
                isPanning = true;
                isPainting = false;
                if (currentTool === 'none') wrapper.style.cursor = 'grabbing';
            } else if (e.button === 0) {
                isPainting = true;
                triggerTool(pos.canvasX, pos.canvasY);
                emitCursorPosition();
            }
        });

        canvas.addEventListener('touchstart', (e) => {
            lastInputWasTouch = true;
            if (e.target === canvas) e.preventDefault();
            
            if (e.touches.length >= 2) {
                isPinching = true;
                isPanning = true;
                isPainting = false;
                blockDrawingUntil = Date.now() + 500; 
                
                deactivateTools(); 
                
                lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                lastMouseX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                lastMouseY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                
            } else if (e.touches.length === 1 && e.target === canvas) {
                isPinching = false;
                
                if (currentTool === 'none') {
                    isPanning = true;
                    isPainting = false;
                    isMoved = false;
                    const pos = getEventData(e);
                    lastMouseX = pos.screenX; 
                    lastMouseY = pos.screenY;
                } else {
                    if (Date.now() < blockDrawingUntil) return;
                    
                    isPanning = false;
                    isPainting = true; 
                    isMoved = false;
                    const pos = getEventData(e);
                    lastMouseX = pos.screenX; 
                    lastMouseY = pos.screenY;
                    emitCursorPosition();
                }
            }
        }, {passive: false});

        function handleMove(e) {
            if (isPinching && e.touches && e.touches.length >= 2) {
                blockDrawingUntil = Date.now() + 500; 
                const currentDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                const zoomFactor = currentDist / lastPinchDist;
                lastPinchDist = currentDist;
                
                const centerClientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const centerClientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                const rect = canvas.getBoundingClientRect();
                
                offsetX += centerClientX - lastMouseX;
                offsetY += centerClientY - lastMouseY;
                
                lastMouseX = centerClientX;
                lastMouseY = centerClientY;

                applyZoom(scale * zoomFactor, false, centerClientX - rect.left, centerClientY - rect.top);
                return;
            }

            const pos = getEventData(e);
            
            if (e.target === canvas) {
                const bx = Math.floor((pos.canvasX - offsetX) / scale);
                const by = Math.floor((pos.canvasY - offsetY) / scale);
                if(bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                    valX.innerText = bx;
                    valY.innerText = by;
                    hoverX = bx;
                    hoverY = by;
                    emitCursorPosition();
                } else {
                    hoverX = -1; hoverY = -1;
                }
            }

            if (isPanning && !isPinching) {
                isMoved = true;
                offsetX += pos.screenX - lastMouseX;
                offsetY += pos.screenY - lastMouseY;
                draw();
                emitCursorPosition();
            } else if (isPainting && currentTool !== 'none') {
                if (Date.now() < blockDrawingUntil) {
                    isPainting = false;
                    return;
                }
                isMoved = true; 
                triggerTool(pos.canvasX, pos.canvasY);
            }
            
            lastMouseX = pos.screenX; lastMouseY = pos.screenY;
        }

        window.addEventListener('mousemove', handleMove);
        window.addEventListener('touchmove', handleMove, {passive: false});

        window.addEventListener('mouseup', () => { 
            isPanning = false; 
            isPainting = false; 
            if (currentTool === 'none') wrapper.style.cursor = 'grab';
        });
        
        canvas.addEventListener('mouseleave', () => { hoverX = -1; hoverY = -1; draw(); });

        window.addEventListener('touchend', (e) => {
            if (e.touches && e.touches.length < 2 && (isPinching || isPanning)) {
                blockDrawingUntil = Date.now() + 500; 
                isPinching = false;
                
                if (e.touches.length === 1) {
                    if (currentTool === 'none') {
                        isPanning = true;
                        isPainting = false;
                    } else {
                        isPainting = false;
                        isPanning = false;
                    }
                    lastMouseX = e.touches[0].clientX;
                    lastMouseY = e.touches[0].clientY;
                }
            }

            if (isPainting && !isMoved && e.target === canvas && e.changedTouches) {
                if (Date.now() >= blockDrawingUntil && currentTool !== 'none') {
                    const pos = getEventData({clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY});
                    triggerTool(pos.canvasX, pos.canvasY);
                    emitCursorPosition();
                }
            }

            if (!e.touches || e.touches.length === 0) {
                isPanning = false; 
                isPainting = false;
            }
        });

        function pickColor(x, y) {
            const p = offCtx.getImageData(x, y, 1, 1).data;
            const hex = "#" + (1 << 24 | p[0] << 16 | p[1] << 8 | p[2]).toString(16).padStart(6, '0').slice(-6);
            updateColor(hex);
            
            if (brushMode === 'normal') btnBrushNormal.click();
            else btnBrushCustom.click();
        }

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
                if (p.shape) {
                    for (const idx of p.shape) {
                        const dx = (idx % 10) - 5;
                        const dy = Math.floor(idx / 10) - 5;
                        ctx.fillRect(p.x + dx + 0.1, p.y + dy + 0.1, 0.8, 0.8);
                    }
                } else {
                    ctx.fillRect(p.x + 0.1, p.y + 0.1, 0.8, 0.8);
                }
            }

            if (hoverX >= 0 && (currentTool === 'brush' || currentTool === 'eraser') && !isPanning && !isPinching) {
                ctx.fillStyle = currentTool === 'eraser' ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.5)';
                if (brushMode === 'custom') {
                    for (let i = 0; i < 100; i++) {
                        if (customBrush[i]) {
                            const dx = (i % 10) - 5;
                            const dy = Math.floor(i / 10) - 5;
                            ctx.fillRect(hoverX + dx, hoverY + dy, 1, 1);
                        }
                    }
                } else {
                    ctx.fillRect(hoverX, hoverY, 1, 1);
                }
            }
            
            ctx.restore();

            if (showCursors) {
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";

                const w = canvas.width;
                const h = canvas.height;
                const margin = 25; 
                const cx = w / 2;
                const cy = h / 2;

                for (const [id, c] of otherCursors.entries()) {
                    const screenX = c.x * scale + offsetX + scale/2;
                    const screenY = c.y * scale + offsetY + scale/2;

                    let drawX = screenX;
                    let drawY = screenY;
                    let isOffscreen = false;

                    if (screenX < 0 || screenX > w || screenY < 0 || screenY > h) {
                        isOffscreen = true;
                        
                        const dx = screenX - cx;
                        const dy = screenY - cy;
                        const maxDx = (w / 2) - margin;
                        const maxDy = (h / 2) - margin;
                        
                        let f = 1;
                        if (dx !== 0) f = Math.min(f, maxDx / Math.abs(dx));
                        if (dy !== 0) f = Math.min(f, maxDy / Math.abs(dy));
                        
                        drawX = cx + dx * f;
                        drawY = cy + dy * f;
                    }

                    if (isOffscreen) {
                        ctx.globalAlpha = 0.6;
                        ctx.font = "16px Arial";
                        ctx.beginPath();
                        ctx.arc(drawX, drawY, 14, 0, Math.PI * 2);
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
                        ctx.fill();
                        ctx.fillText(c.emoji || '👽', drawX, drawY);
                        ctx.globalAlpha = 1.0;
                    } else {
                        ctx.font = Math.max(20, scale * 2) + "px Arial";
                        ctx.fillText(c.emoji || '👽', drawX, drawY);
                    }
                }
            }
        }

        let ws;
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.type === 'auth') {
                    serverSessionKey = data.key;
                } else if (data.type === 'cursor') {
                    otherCursors.set(data.id, { x: data.x, y: data.y, emoji: data.emoji, time: Date.now() });
                    if (showCursors) draw();
                } else if (data.type === 'cursor_remove') {
                    otherCursors.delete(data.id); 
                    if (showCursors) draw();
                } else if (data.type === 'pixel') {
                    offCtx.fillStyle = data.color;
                    const shapeStr = data.shape ? JSON.stringify(data.shape) : null;

                    if (data.shape) {
                        for (const idx of data.shape) {
                            const dx = (idx % 10) - 5;
                            const dy = Math.floor(idx / 10) - 5;
                            offCtx.fillRect(data.x + dx, data.y + dy, 1, 1);
                        }
                    } else {
                        offCtx.fillRect(data.x, data.y, 1, 1);
                    }
                    
                    const lenBefore = pendingQueue.length;
                    pendingQueue = pendingQueue.filter(p => !(p.x === data.x && p.y === data.y && p.shapeStr === shapeStr));
                    draw();
                    if (pendingQueue.length !== lenBefore) updateProgressBar();

                } else if (data.type === 'error') {
                    topInfoEl.style.color = "#ff9800";
                    statusEl.innerText = data.msg || "Ralentissez...";
                    clearTimeout(window.statusTimeout);
                    window.statusTimeout = setTimeout(() => {
                        if (isReady) {
                            topInfoEl.style.color = "#fff";
                            statusEl.innerText = "Prêt à peindre";
                        }
                    }, 2000);

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
            if (pendingQueue.length > 2000) return;
            if (pendingQueue.length === 0) totalPendingBatch = 0;

            const colorToUse = currentTool === 'eraser' ? DEFAULT_BG_COLOR : currentColor;
            const targetRgb = hexToRgbClient(colorToUse);
            
            const pendingState = new Map();
            for (const item of pendingQueue) {
                if (item.shape) {
                    for (const idx of item.shape) {
                        const dx = (idx % 10) - 5;
                        const dy = Math.floor(idx / 10) - 5;
                        pendingState.set((item.x + dx) + ',' + (item.y + dy), item.color);
                    }
                } else {
                    pendingState.set(item.x + ',' + item.y, item.color);
                }
            }

            let filteredOffsets = null; 

            if (brushMode === 'normal') {
                if (bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                    const key = bx + ',' + by;
                    if (pendingState.has(key)) {
                        if (pendingState.get(key) === colorToUse) return; 
                    } else {
                        const p = offCtx.getImageData(bx, by, 1, 1).data;
                        if (p[0] === targetRgb.r && p[1] === targetRgb.g && p[2] === targetRgb.b) return; 
                    }
                } else {
                    return; 
                }
            } else {
                filteredOffsets = [];
                
                const cropX = Math.max(0, bx - 5);
                const cropY = Math.max(0, by - 5);
                const cropW = Math.min(SIZE, bx + 5) - cropX;
                const cropH = Math.min(SIZE, by + 5) - cropY;
                
                let imgData = null;
                if (cropW > 0 && cropH > 0) {
                    imgData = offCtx.getImageData(cropX, cropY, cropW, cropH).data;
                }

                for (let i = 0; i < 100; i++) {
                    if (customBrush[i]) {
                        const dx = (i % 10) - 5;
                        const dy = Math.floor(i / 10) - 5;
                        const px = bx + dx;
                        const py = by + dy;
                        
                        if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) {
                            const key = px + ',' + py;
                            
                            if (pendingState.has(key)) {
                                if (pendingState.get(key) !== colorToUse) {
                                    filteredOffsets.push(i); 
                                }
                            } else if (imgData) {
                                const localX = px - cropX;
                                const localY = py - cropY;
                                const dataIdx = (localY * cropW + localX) * 4;
                                
                                if (imgData[dataIdx] !== targetRgb.r || imgData[dataIdx+1] !== targetRgb.g || imgData[dataIdx+2] !== targetRgb.b) {
                                    filteredOffsets.push(i);
                                }
                            }
                        }
                    }
                }
                if (filteredOffsets.length === 0) return; 
            }

            const shapeStr = brushMode === 'custom' ? JSON.stringify(filteredOffsets) : null;

            pendingQueue.push({ 
                x: bx, y: by, color: colorToUse, 
                shapeStr: shapeStr, 
                shape: filteredOffsets,
                retries: 0 
            });
            totalPendingBatch++;
            
            draw();
            updateProgressBar();
        }

        setInterval(() => {
            const now = Date.now();
            if (!isPainting && pendingQueue.length > 0 && now - lastSendTime >= 130) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const p = pendingQueue[0]; 
                    p.retries = (p.retries || 0) + 1;

                    if (p.retries > 150) {
                        pendingQueue.shift();
                        draw();
                        updateProgressBar(); 
                        return;
                    }

                    const proofToken = (p.x * 7) + (p.y * 3) + serverSessionKey;

                    ws.send(JSON.stringify({ 
                        type: 'pixel', 
                        x: p.x, y: p.y, 
                        color: p.color, 
                        shape: p.shape,
                        token: proofToken
                    }));
                    
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
