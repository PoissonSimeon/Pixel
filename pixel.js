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
        board = Buffer.alloc(BOARD_SIZE, 255); // Blanc
        console.log('[INIT] Nouveau plateau blanc créé.');
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
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
        canvas { display: block; touch-action: none; cursor: crosshair; }
        
        #ui { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); background: rgba(20, 20, 20, 0.85); padding: 12px 25px; border-radius: 40px; display: flex; gap: 20px; align-items: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
        input[type="color"] { border: none; width: 45px; height: 45px; border-radius: 50%; cursor: pointer; padding: 0; background: transparent; outline: none; }
        input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
        input[type="color"]::-webkit-color-swatch { border: 3px solid #fff; border-radius: 50%; box-shadow: 0 0 10px rgba(0,0,0,0.3); }
        
        #hexInput { width: 75px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 14px; font-weight: bold; text-transform: uppercase; outline: none; border-radius: 5px; padding: 5px; text-align: center; }
        
        .tools { display: flex; gap: 10px; border-right: 1px solid rgba(255,255,255,0.2); padding-right: 20px; }
        .tool-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: all 0.2s; outline: none; padding: 0; }
        .tool-btn:hover { background: rgba(255,255,255,0.2); }
        .tool-btn.active { background: rgba(76, 175, 80, 0.5); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.5); }

        #exportBtn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: background 0.2s; outline: none; padding: 0; }
        #exportBtn:hover { background: rgba(255,255,255,0.2); }

        .info-block { display: flex; flex-direction: column; color: #fff; }
        .info-label { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
        .info-value { font-size: 16px; font-weight: bold; }
        
        #cooldown-bar { position: absolute; bottom: 0; left: 0; height: 4px; background: #4caf50; width: 0%; border-radius: 0 0 40px 40px; transition: width 0.1s linear; }
        
        #top-info { position: absolute; top: 15px; right: 15px; background: rgba(20, 20, 20, 0.85); padding: 8px 15px; border-radius: 20px; color: #fff; font-size: 13px; font-weight: bold; display: flex; gap: 15px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); pointer-events: none; }
        .online-dot { color: #4caf50; }
    </style>
</head>
<body>
    <canvas id="viewCanvas"></canvas>
    
    <div id="top-info">
        <span>X: <span id="valX">0</span> Y: <span id="valY">0</span></span>
        <span><span class="online-dot">●</span> <span id="onlineCount">1</span> en ligne</span>
    </div>

    <div id="ui">
        <div class="tools">
            <button id="btnBrush" class="tool-btn active" title="Pinceau">🖌️</button>
            <button id="btnPipette" class="tool-btn" title="Pipette">💧</button>
        </div>
        <div style="display: flex; flex-direction: column; align-items: center; gap: 5px;">
            <input type="color" id="colorPicker" value="#ff0000">
            <input type="text" id="hexInput" value="#ff0000" maxlength="7">
        </div>
        <button id="exportBtn" title="Exporter la toile en PNG">💾</button>
        <div class="info-block">
            <span class="info-label">État</span>
            <span class="info-value" id="status">Connexion...</span>
        </div>
        <div id="cooldown-bar"></div>
    </div>

    <script>
        const canvas = document.getElementById('viewCanvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        const colorPicker = document.getElementById('colorPicker');
        const hexInput = document.getElementById('hexInput');
        const btnBrush = document.getElementById('btnBrush');
        const btnPipette = document.getElementById('btnPipette');
        const statusEl = document.getElementById('status');
        const valX = document.getElementById('valX');
        const valY = document.getElementById('valY');
        const onlineCount = document.getElementById('onlineCount');
        const cooldownBar = document.getElementById('cooldown-bar');
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
        let imgData = offCtx.createImageData(SIZE, SIZE);

        let isDragging = false;
        let lastMouseX = 0;
        let lastMouseY = 0;
        let isMoved = false;
        let currentTool = 'brush'; // 'brush' or 'pipette'
        
        let pendingQueue = []; // File d'attente pour les pixels posés localement
        let lastSendTime = 0;

        // Synchro de la couleur
        function updateColor(hex) {
            colorPicker.value = hex;
            hexInput.value = hex;
        }
        colorPicker.addEventListener('input', (e) => updateColor(e.target.value));
        hexInput.addEventListener('input', (e) => {
            let val = e.target.value;
            if (!val.startsWith('#')) val = '#' + val;
            if (/^#[0-9a-fA-F]{6}$/.test(val)) updateColor(val);
        });

        // Gestion des outils
        btnBrush.addEventListener('click', () => { currentTool = 'brush'; btnBrush.classList.add('active'); btnPipette.classList.remove('active'); canvas.style.cursor = 'crosshair'; });
        btnPipette.addEventListener('click', () => { currentTool = 'pipette'; btnPipette.classList.add('active'); btnBrush.classList.remove('active'); canvas.style.cursor = 'crosshair'; });

        // Empêcher le menu contextuel du clic droit (indispensable pour le drag droit)
        canvas.addEventListener('contextmenu', e => e.preventDefault());

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            if(scale === 1 && offsetX === 0 && offsetY === 0) {
                scale = Math.min(window.innerWidth / SIZE, window.innerHeight / SIZE) * 0.9;
                offsetX = (window.innerWidth - (SIZE * scale)) / 2;
                offsetY = (window.innerHeight - (SIZE * scale)) / 2;
            }
            draw();
        }
        window.addEventListener('resize', resize);
        
        function onPointerDown(e) {
            // Clic droit (2) ou tactile (touches) pour agripper et bouger
            if (e.button === 2 || e.touches) {
                isDragging = true;
            }
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
                
                // Peindre en continu si le clic gauche est maintenu et qu'on ne déplace pas la caméra
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
            const wasDragging = isDragging;
            isDragging = false;
            
            // Si on relâche le clic droit, on arrête juste le drag
            if (e.button === 2) return;

            // Action du clic gauche ou du tap (s'il n'y a pas eu de mouvement)
            if (!isMoved && isReady && (e.button === 0 || e.changedTouches)) {
                const clientX = e.clientX || (e.changedTouches ? e.changedTouches[0].clientX : lastMouseX);
                const clientY = e.clientY || (e.changedTouches ? e.changedTouches[0].clientY : lastMouseY);
                
                const bx = Math.floor((clientX - offsetX) / scale);
                const by = Math.floor((clientY - offsetY) / scale);
                
                if (bx >= 0 && bx < SIZE && by >= 0 && by < SIZE) {
                    if (currentTool === 'brush') {
                        placePixel(bx, by);
                    } else if (currentTool === 'pipette') {
                        pickColor(bx, by);
                    }
                }
            }
        }

        // Action : Pipette
        function pickColor(x, y) {
            const idx = (y * SIZE + x) * 4;
            const r = imgData.data[idx];
            const g = imgData.data[idx+1];
            const b = imgData.data[idx+2];
            // Format hexadécimal
            const hex = "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).padStart(6, '0').slice(-6);
            updateColor(hex);
            
            // Repasse automatiquement sur le pinceau pour un confort d'utilisation
            btnBrush.click();
        }

        canvas.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        
        canvas.addEventListener('touchstart', onPointerDown, {passive: false});
        window.addEventListener('touchmove', onPointerMove, {passive: false});
        window.addEventListener('touchend', onPointerUp);

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSpeed = 0.002;
            const zoomFactor = Math.exp(e.deltaY * -zoomSpeed);
            
            const mouseX = e.clientX;
            const mouseY = e.clientY;
            
            offsetX = mouseX - (mouseX - offsetX) * zoomFactor;
            offsetY = mouseY - (mouseY - offsetY) * zoomFactor;
            scale *= zoomFactor;
            
            // Limité à 30 pour éviter le bug d'écran noir (limite du navigateur à ~32767 pixels)
            scale = Math.max(0.1, Math.min(scale, 30)); 
            draw();
        }, {passive: false});

        function draw() {
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            offCtx.putImageData(imgData, 0, 0);
            ctx.imageSmoothingEnabled = false; 
            ctx.drawImage(offCanvas, offsetX, offsetY, SIZE * scale, SIZE * scale);

            // Dessiner les pixels en attente d'envoi (avec encadré blanc)
            for (const p of pendingQueue) {
                const pxX = offsetX + p.x * scale;
                const pxY = offsetY + p.y * scale;
                
                ctx.fillStyle = p.color;
                ctx.fillRect(pxX, pxY, scale, scale);
                
                // Encadré blanc
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = scale > 5 ? 2 : 1;
                ctx.strokeRect(pxX, pxY, scale, scale);
                
                // Petit contour intérieur noir pour une meilleure visibilité sur fond clair (quand zoomé)
                if (scale > 5) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(pxX + 2, pxY + 2, scale - 4, scale - 4);
                }
            }
        }

        let ws;
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.type === 'pixel') {
                    const { r, g, b } = hexToRgb(data.color);
                    const idx = (data.y * SIZE + data.x) * 4;
                    imgData.data[idx] = r;
                    imgData.data[idx+1] = g;
                    imgData.data[idx+2] = b;
                    imgData.data[idx+3] = 255;
                    
                    // Si on reçoit la validation, on retire le pixel de la file d'attente
                    pendingQueue = pendingQueue.filter(p => !(p.x === data.x && p.y === data.y && p.color.toLowerCase() === data.color.toLowerCase()));
                    
                    draw();
                } else if (data.type === 'error') {
                    // Si le serveur rejette (spam, etc), on supprime le pixel bloquant pour avancer dans la file
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

        function hexToRgb(hex) {
            return {
                r: parseInt(hex.slice(1, 3), 16),
                g: parseInt(hex.slice(3, 5), 16),
                b: parseInt(hex.slice(5, 7), 16)
            };
        }

        function placePixel(bx, by) {
            // Limite la file d'attente (évite de faire crasher le navigateur si on peint des milliers de pixels sans internet)
            if (pendingQueue.length > 500) return;

            const color = colorPicker.value;
            const existing = pendingQueue.find(p => p.x === bx && p.y === by);
            
            // Si le pixel est déjà dans la file locale, on met juste sa couleur à jour
            if (existing) {
                existing.color = color;
            } else {
                pendingQueue.push({ x: bx, y: by, color: color });
            }
            draw();
        }

        // Boucle d'envoi automatique au serveur (1 pixel toutes les 110ms)
        setInterval(() => {
            const now = Date.now();
            // On utilise 110ms pour être parfaitement sûr de passer le contrôle de 100ms du serveur
            if (pendingQueue.length > 0 && now - lastSendTime >= 110) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const p = pendingQueue[0]; // Récupère le pixel le plus ancien
                    
                    ws.send(JSON.stringify({
                        type: 'pixel',
                        x: p.x,
                        y: p.y,
                        color: p.color
                    }));
                    
                    lastSendTime = now;
                    
                    // Animation de la barre de progression pour indiquer le rythme d'envoi
                    cooldownBar.style.transition = 'none';
                    cooldownBar.style.width = '0%';
                    setTimeout(() => {
                        cooldownBar.style.transition = 'width 0.1s linear';
                        cooldownBar.style.width = '100%';
                    }, 10);
                }
            }
        }, 10); // Vérification de la file très récurrente (passée à 10ms pour plus de réactivité)

        exportBtn.addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = 'pixel_florianscher_fr.png';
            link.href = offCanvas.toDataURL('image/png');
            link.click();
        });

        fetch('/board.dat')
            .then(res => res.arrayBuffer())
            .then(buffer => {
                const view = new Uint8Array(buffer);
                for (let i = 0, j = 0; i < view.length; i += 3, j += 4) {
                    imgData.data[j]     = view[i];     
                    imgData.data[j + 1] = view[i + 1]; 
                    imgData.data[j + 2] = view[i + 2]; 
                    imgData.data[j + 3] = 255;         
                }
                isReady = true;
                statusEl.innerText = "Prêt à peindre";
                statusEl.style.color = "#4caf50";
                cooldownBar.style.width = '100%';
                
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
