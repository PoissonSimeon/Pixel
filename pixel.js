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
    ws.clientId = Math.random().toString(36).substring(2, 9); // ID unique par connexion

    const sendOnlineCount = () => {
        const msg = JSON.stringify({ type: 'stats', online: wss.clients.size });
        wss.clients.forEach(client => {
            if (client.readyState === ws.OPEN) client.send(msg);
        });
    };
    sendOnlineCount();

    ws.on('message', (message) => {
        // La limite passe à 1024 pour permettre l'envoi de la matrice Custom 10x10 sans bloquer
        if (message.length > 1024) return ws.close(1009, 'Message trop lourd');

        try {
            const data = JSON.parse(message);
            
            // Gestion de l'affichage en temps réel des curseurs
            if (data.type === 'cursor') {
                const broadcastMsg = JSON.stringify({ type: 'cursor', id: ws.clientId, x: data.x, y: data.y });
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === ws.OPEN) client.send(broadcastMsg);
                });
                return;
            }

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
                const shape = data.shape;

                if (isNaN(x) || isNaN(y) || x < -10 || x >= BOARD_WIDTH || y < -10 || y >= BOARD_HEIGHT) return;
                if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

                const { r, g, b } = hexToRgb(color);
                
                // Application serveur
                if (shape && Array.isArray(shape)) {
                    if (shape.length > 100) return; // Sécurité
                    for (let i = 0; i < shape.length; i++) {
                        const idx = parseInt(shape[i]);
                        if (isNaN(idx) || idx < 0 || idx > 99) continue;
                        
                        // Calcul de la position par rapport au centre (5,5) de la matrice 10x10
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
                    // Pinceau normal 1x1
                    if (x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT) {
                        const boardIdx = (y * BOARD_WIDTH + x) * 3;
                        board[boardIdx] = r;
                        board[boardIdx + 1] = g;
                        board[boardIdx + 2] = b;
                    }
                }

                cooldowns.set(ip, now);

                const broadcastMsg = JSON.stringify({ type: 'pixel', x, y, color, shape });
                wss.clients.forEach(client => {
                    if (client.readyState === ws.OPEN) client.send(broadcastMsg);
                });
            }
        } catch (err) {}
    });

    ws.on('close', () => {
        // Informe tout le monde que le curseur a disparu
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pixel - florianscher.fr</title>
    <!-- Importation de la roue chromatique iro.js -->
    <script src="https://cdn.jsdelivr.net/npm/@jaames/iro@5"></script>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #111; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; touch-action: none; }
        
        #app { display: flex; flex-direction: column; height: 100vh; width: 100vw; position: relative; }
        
        #canvas-wrapper { flex: 1; position: relative; overflow: hidden; background: #1a1a1a; cursor: crosshair; }
        canvas { display: block; touch-action: none; width: 100%; height: 100%; }
        
        #hud { 
            background: #1e1e1e; border-top: 1px solid #333; padding: 12px 20px; 
            display: flex; justify-content: center; align-items: center; 
            flex-wrap: wrap; gap: 20px; z-index: 20; box-shadow: 0 -5px 20px rgba(0,0,0,0.5);
        }

        .hud-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

        .tool-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: all 0.2s; outline: none; padding: 0; }
        .tool-btn:hover { background: rgba(255,255,255,0.2); }
        .tool-btn.active { background: rgba(76, 175, 80, 0.5); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.5); }
        .tool-btn-txt { font-size: 14px; font-weight: bold; }
        
        .icon-btn { font-size: 18px; cursor: pointer; transition: transform 0.1s; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; color: white;}
        .icon-btn:hover { transform: scale(1.2); }
        #zoomSlider { cursor: pointer; width: 100px; accent-color: #4caf50; }

        #color-btn-indicator { width: 45px; height: 45px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.5); cursor: pointer; box-shadow: 0 0 10px rgba(0,0,0,0.3); transition: transform 0.1s; }
        #color-btn-indicator:hover { transform: scale(1.1); border-color: white; }

        #colorPanel { display: none; position: absolute; bottom: 90px; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 20, 0.95); padding: 20px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(15px); flex-direction: column; align-items: center; gap: 15px; box-shadow: 0 15px 40px rgba(0,0,0,0.8); z-index: 10; }
        #hexInput { width: 90px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 16px; font-weight: bold; text-transform: uppercase; outline: none; border-radius: 8px; padding: 8px; text-align: center; }

        /* Editeur 10x10 Custom Brush avec effet d'agrandissement */
        #brushEditorContainer { display: none; background: #222; padding: 6px; border-radius: 8px; border: 1px solid #444; }
        #brushEditorWrapper { width: 60px; height: 60px; position: relative; }
        #brushEditor { 
            position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
            display: grid; grid-template-columns: repeat(10, 1fr); 
            width: 60px; height: 60px; background: #ccc; gap: 1px; border: 1px solid #555; 
            cursor: crosshair; touch-action: none; 
            transition: width 0.2s ease, height 0.2s ease;
        }
        #brushEditorContainer:hover #brushEditor,
        #brushEditor.expanded {
            width: 180px; height: 180px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.8);
            border: 2px solid #888;
            border-radius: 4px;
            z-index: 50;
        }
        .brush-cell { background: white; width: 100%; height: 100%; user-select: none; }
        .brush-cell.active { background: black; }

        /* Infos Top optimisées */
        #top-info { position: absolute; top: 15px; right: 15px; background: rgba(20, 20, 20, 0.85); padding: 8px 15px; border-radius: 20px; color: #fff; font-size: 13px; font-weight: bold; display: flex; gap: 15px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); pointer-events: none; z-index: 10; }
        .info-segment { display: flex; align-items: center; gap: 5px; }
        .coords { color: #aaa; width: 85px; text-align: right; }
        .online-dot { color: #4caf50; font-size: 16px; }
        #status { color: #f44336; border-left: 1px solid #444; padding-left: 15px; }

        /* UI de la Barre de Progression Dynamique */
        #progress-container {
            position: absolute; top: 60px; left: 50%; transform: translateX(-50%);
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

        /* --- RESPONSIVE MOBILE --- */
        @media (max-width: 768px) {
            #hud { padding: 8px 10px; gap: 10px; }
            .tool-btn { width: 40px; height: 40px; font-size: 18px; }
            .tool-btn-txt { font-size: 12px; }
            #color-btn-indicator { width: 40px; height: 40px; }
            
            /* Cacher le slider de zoom car on implémente le pinch-to-zoom */
            #zoomSlider { display: none; } 
            
            /* Optimisation du bloc d'infos du haut */
            #top-info { top: 10px; right: 10px; left: 10px; padding: 6px 12px; font-size: 11px; justify-content: space-between; }
            #status { border: none; padding-left: 0; }
        }
    </style>
</head>
<body>
    <div id="app">
        
        <!-- Bloc d'infos centralisé en haut -->
        <div id="top-info">
            <span class="info-segment coords">X:<span id="valX">0</span> Y:<span id="valY">0</span></span>
            <span class="info-segment"><span class="online-dot">●</span> <span id="onlineCount">1</span> <span class="hide-mobile">en ligne</span></span>
            <span class="info-segment" id="status">Connexion...</span>
        </div>

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
            <!-- Boutons de zoom (slider masqué sur mobile) -->
            <div class="hud-group hide-mobile">
                <span class="icon-btn" id="zoomOutBtn" title="Dézoom max">➖</span>
                <input type="range" id="zoomSlider" min="0.1" max="30" step="0.1" value="1">
                <span class="icon-btn" id="zoomInBtn" title="Zoom max">➕</span>
            </div>

            <!-- Outils principaux -->
            <div class="hud-group">
                <button id="btnBrushNormal" class="tool-btn tool-btn-txt active" title="Pinceau 1x1">1x1</button>
                <button id="btnBrushCustom" class="tool-btn" title="Pinceau Personnalisé">🖌️</button>
                <button id="btnEraser" class="tool-btn" title="Gomme">🧼</button>
                
                <!-- Editeur de pinceau custom -->
                <div id="brushEditorContainer">
                    <div id="brushEditorWrapper">
                        <div id="brushEditor"></div>
                    </div>
                </div>

                <div id="color-btn-indicator" style="background-color: #ff0000;" title="Choisir une couleur"></div>
                <button id="btnPipette" class="tool-btn" title="Pipette">💧</button>
                <button id="btnCursors" class="tool-btn" title="Afficher les joueurs">📡</button>
                <button id="exportBtn" class="tool-btn" title="Exporter en PNG">💾</button>
            </div>
        </div>
    </div>

    <script>
        const canvas = document.getElementById('viewCanvas');
        const wrapper = document.getElementById('canvas-wrapper');
        const ctx = canvas.getContext('2d', { alpha: false });
        
        const btnBrushNormal = document.getElementById('btnBrushNormal');
        const btnBrushCustom = document.getElementById('btnBrushCustom');
        const btnEraser = document.getElementById('btnEraser');
        const brushEditorContainer = document.getElementById('brushEditorContainer');
        const brushEditor = document.getElementById('brushEditor');

        const btnPipette = document.getElementById('btnPipette');
        const btnCursors = document.getElementById('btnCursors');
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
        const DEFAULT_BG_COLOR = '#1a1a1a';
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
        
        // Variables pour Pinch-To-Zoom (Mobile)
        let isPinching = false;
        let lastPinchDist = null;

        let currentTool = 'brush'; // 'brush', 'eraser' or 'pipette'
        let brushMode = 'normal'; // 'normal' or 'custom'
        let currentColor = '#ff0000';
        
        let pendingQueue = []; 
        let lastSendTime = 0;
        let hoverX = -1;
        let hoverY = -1;

        let totalPendingBatch = 0;
        let progressHideTimeout;

        // Variables pour les curseurs des autres joueurs
        let showCursors = false;
        const otherCursors = new Map(); // id -> {x, y, time}
        let lastCursorSendTime = 0;

        // --- GESTION DE L'EDITEUR DE PINCEAU (10x10) ---
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

        brushEditorContainer.addEventListener('mouseenter', () => brushEditor.classList.add('expanded'));
        brushEditorContainer.addEventListener('mouseleave', () => brushEditor.classList.remove('expanded'));

        document.addEventListener('touchstart', (e) => {
            if (!brushEditorContainer.contains(e.target) && !btnBrushCustom.contains(e.target)) {
                brushEditor.classList.remove('expanded');
            }
        }, {passive: true});

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
            if (!brushEditor.classList.contains('expanded')) brushEditor.classList.add('expanded');
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
            if (!brushEditor.classList.contains('expanded')) {
                brushEditor.classList.add('expanded');
                return; 
            }
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

        colorBtnIndicator.addEventListener('click', () => {
            colorPanel.style.display = colorPanel.style.display === 'flex' ? 'none' : 'flex';
        });

        canvas.addEventListener('mousedown', () => {
            if (colorPanel.style.display === 'flex') colorPanel.style.display = 'none';
        });

        // --- GESTION DES OUTILS ---
        function setActiveTool(toolBtn) {
            btnBrushNormal.classList.remove('active');
            btnBrushCustom.classList.remove('active');
            btnEraser.classList.remove('active');
            btnPipette.classList.remove('active');
            toolBtn.classList.add('active');
            wrapper.style.cursor = 'crosshair';
        }

        btnBrushNormal.addEventListener('click', () => { 
            currentTool = 'brush'; brushMode = 'normal'; 
            setActiveTool(btnBrushNormal); 
            brushEditorContainer.style.display = 'none'; 
        });
        
        btnBrushCustom.addEventListener('click', () => { 
            currentTool = 'brush'; brushMode = 'custom'; 
            setActiveTool(btnBrushCustom); 
            brushEditorContainer.style.display = 'block'; 
        });

        btnEraser.addEventListener('click', () => { 
            currentTool = 'eraser'; 
            setActiveTool(btnEraser); 
            brushEditorContainer.style.display = brushMode === 'custom' ? 'block' : 'none'; 
        });

        btnPipette.addEventListener('click', () => { 
            currentTool = 'pipette'; 
            setActiveTool(btnPipette); 
            brushEditorContainer.style.display = 'none'; 
        });

        btnCursors.addEventListener('click', () => {
            showCursors = !showCursors;
            btnCursors.classList.toggle('active', showCursors);
            draw();
        });

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
                if (currentTool === 'brush' || currentTool === 'eraser') placePixel(bx, by);
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
            // Logique de Pinch-To-Zoom tactile
            if (e.touches.length === 2) {
                isPinching = true;
                isPanning = false;
                isPainting = false;
                lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                return;
            }

            const pos = getEventData(e);
            lastMouseX = pos.screenX; lastMouseY = pos.screenY;
            isMoved = false;
            isPanning = true; 
        }, {passive: false});

        function handleMove(e) {
            if (isPinching && e.touches && e.touches.length === 2) {
                const currentDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                const zoomFactor = currentDist / lastPinchDist;
                lastPinchDist = currentDist;
                
                const centerClientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const centerClientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                const rect = canvas.getBoundingClientRect();
                
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
                    
                    // Envoi de la position du curseur au serveur
                    const now = Date.now();
                    if (now - lastCursorSendTime > 100 && ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'cursor', x: hoverX, y: hoverY }));
                        lastCursorSendTime = now;
                    }

                } else {
                    hoverX = -1; hoverY = -1;
                }
            }

            if (isPanning && !isPinching) {
                isMoved = true;
                offsetX += pos.screenX - lastMouseX;
                offsetY += pos.screenY - lastMouseY;
                draw();
            } else if (isPainting && (currentTool === 'brush' || currentTool === 'eraser')) {
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
            if (e.touches.length < 2) isPinching = false;
            
            if (isPanning && !isMoved && !isPinching && e.target === canvas) {
                const pos = getEventData(e);
                triggerTool(pos.canvasX, pos.canvasY);
            }
            isPanning = false; isPainting = false;
        });

        function pickColor(x, y) {
            const p = offCtx.getImageData(x, y, 1, 1).data;
            const hex = "#" + (1 << 24 | p[0] << 16 | p[1] << 8 | p[2]).toString(16).padStart(6, '0').slice(-6);
            updateColor(hex);
            
            if (brushMode === 'normal') btnBrushNormal.click();
            else btnBrushCustom.click();
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

            // Dessin des pixels en attente
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

            // Prévisualisation du pinceau sous la souris
            if (hoverX >= 0 && (currentTool === 'brush' || currentTool === 'eraser') && !isPanning) {
                ctx.fillStyle = currentTool === 'eraser' ? 'rgba(255, 100, 100, 0.5)' : 'rgba(255, 255, 255, 0.5)';
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

            // Affichage des curseurs des autres joueurs par-dessus le reste
            if (showCursors) {
                const now = Date.now();
                for (const [id, c] of otherCursors.entries()) {
                    if (now - c.time > 10000) { 
                        otherCursors.delete(id); // Supprime si inactif > 10s
                        continue;
                    }
                    
                    // Calcul des coordonnées à l'écran, peu importe le zoom
                    const screenX = c.x * scale + offsetX + scale/2;
                    const screenY = c.y * scale + offsetY + scale/2;

                    ctx.beginPath();
                    // Le rayon reste constant, garantissant la visibilité (min 6px de rayon)
                    const radius = Math.max(6, scale * 0.4); 
                    ctx.arc(screenX, screenY, radius, 0, 2*Math.PI);
                    ctx.fillStyle = 'rgba(244, 67, 54, 0.8)'; // Rouge visible
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = '#fff';
                    ctx.stroke();
                }
            }
        }

        // --- WEBSOCKET ET API ---
        let ws;
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.type === 'cursor') {
                    otherCursors.set(data.id, { x: data.x, y: data.y, time: Date.now() });
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
                    
                    if (pendingQueue.length !== lenBefore) {
                        draw();
                        updateProgressBar();
                    }
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
            if (pendingQueue.length === 0) totalPendingBatch = 0;

            // La gomme applique la couleur de fond (#1a1a1a)
            const colorToUse = currentTool === 'eraser' ? DEFAULT_BG_COLOR : currentColor;
            const targetRgb = hexToRgbClient(colorToUse);
            let filteredOffsets = null; 

            if (brushMode === 'normal') {
                if (bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                    const p = offCtx.getImageData(bx, by, 1, 1).data;
                    if (p[0] === targetRgb.r && p[1] === targetRgb.g && p[2] === targetRgb.b) {
                        return; // Déjà de la bonne couleur
                    }
                } else {
                    return; 
                }
            } else {
                filteredOffsets = [];
                for (let i = 0; i < 100; i++) {
                    if (customBrush[i]) {
                        const dx = (i % 10) - 5;
                        const dy = Math.floor(i / 10) - 5;
                        const px = bx + dx;
                        const py = by + dy;
                        
                        if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) {
                            const p = offCtx.getImageData(px, py, 1, 1).data;
                            if (p[0] !== targetRgb.r || p[1] !== targetRgb.g || p[2] !== targetRgb.b) {
                                filteredOffsets.push(i);
                            }
                        }
                    }
                }
                if (filteredOffsets.length === 0) return; 
            }

            const shapeStr = brushMode === 'custom' ? JSON.stringify(filteredOffsets) : null;

            const existing = pendingQueue.find(p => p.x === bx && p.y === by && p.shapeStr === shapeStr);
            if (existing) {
                existing.color = colorToUse;
                existing.retries = 0;
            } else {
                pendingQueue.push({ 
                    x: bx, y: by, color: colorToUse, 
                    shapeStr: shapeStr, 
                    shape: filteredOffsets,
                    retries: 0 
                });
                totalPendingBatch++;
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
                        updateProgressBar(); 
                        return;
                    }

                    ws.send(JSON.stringify({ 
                        type: 'pixel', 
                        x: p.x, y: p.y, 
                        color: p.color, 
                        shape: p.shape 
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
