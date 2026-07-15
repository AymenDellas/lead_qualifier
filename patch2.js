const fs = require('fs');
let dockerfile = fs.readFileSync('Dockerfile', 'utf8');
dockerfile = dockerfile.replace('procps \\', 'procps \\\n    xvfb \\\n    x11vnc \\\n    fluxbox \\');
fs.writeFileSync('Dockerfile', dockerfile);

let dc = fs.readFileSync('../docker-compose.yml', 'utf8');
dc = dc.replace('command: ["sh", "-c", "touch .env.local && node worker.cjs"]', 'command: ["sh", "-c", "rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1366x768x24 & sleep 2 && fluxbox & sleep 2 && x11vnc -display :99 -forever -nopw -quiet -listen 0.0.0.0 & export DISPLAY=:99 && touch .env.local && node worker.cjs"]\n    ports:\n      - "5900:5900"');
fs.writeFileSync('../docker-compose.yml', dc);

console.log("Patched files");
