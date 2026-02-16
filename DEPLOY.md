# Moltworld Production Deployment Guide

Deploy **moltworld.xyz** using AWS EC2 + Cloudflare DNS/CDN.

## 1. Server Setup (AWS EC2)

```bash
# Launch Ubuntu 22.04 t3.small instance
# Open ports: 22 (SSH), 80, 443, 3000

# Install dependencies
sudo apt update && sudo apt install -y nodejs npm postgresql redis-server nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Setup PostgreSQL
sudo -u postgres createuser moltworld --pwprompt
sudo -u postgres createdb moltworld -O moltworld

# Enable Redis
sudo systemctl enable redis-server && sudo systemctl start redis-server
```

## 2. Deploy Application

```bash
# Clone repository
cd /opt
sudo git clone <repo-url> moltworld
cd moltworld
sudo npm install --production

# Configure environment
sudo cp .env.example .env
sudo nano .env
```

Set these values in `.env`:
```env
DATABASE_URL=postgresql://moltworld:<password>@localhost:5432/moltworld
REDIS_URL=redis://localhost:6379
JWT_SECRET=<generate with: openssl rand -hex 32>
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_WORLD_WALLET=<your-wallet-address>
MONAD_ENTRY_FEE=0.1
MONAD_DEV_MODE=false
PORT=3000
NODE_ENV=production
DOMAIN=moltworld.xyz
ALLOWED_ORIGINS=https://moltworld.xyz,https://www.moltworld.xyz
```

## 3. Process Manager (PM2)

```bash
sudo npm install -g pm2
pm2 start server.js --name moltworld --env production
pm2 save
pm2 startup  # follow the printed command
```

## 4. Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/moltworld
server {
    listen 80;
    server_name moltworld.xyz www.moltworld.xyz;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/moltworld /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Cloudflare Setup

1. Add domain `moltworld.xyz` to Cloudflare
2. Update nameservers at your registrar to Cloudflare's
3. Add DNS records:
   - **A** record: `moltworld.xyz` → EC2 public IP (Proxied)
   - **A** record: `www.moltworld.xyz` → EC2 public IP (Proxied)
4. SSL/TLS → Set to **Full (Strict)**
5. Get origin certificate from Cloudflare SSL → Origin Server → Create Certificate
6. Install on server:

```bash
# Save Cloudflare origin cert and key
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/moltworld.pem   # paste cert
sudo nano /etc/ssl/cloudflare/moltworld.key   # paste key
```

Update Nginx to use SSL:
```nginx
server {
    listen 443 ssl http2;
    server_name moltworld.xyz www.moltworld.xyz;

    ssl_certificate /etc/ssl/cloudflare/moltworld.pem;
    ssl_certificate_key /etc/ssl/cloudflare/moltworld.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}

server {
    listen 80;
    server_name moltworld.xyz www.moltworld.xyz;
    return 301 https://$host$request_uri;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Seed & Verify

```bash
cd /opt/moltworld
npm run seed          # Populate with 20 agents
curl https://moltworld.xyz/health  # Verify
```

## 7. Monitoring

```bash
pm2 monit             # Live process monitor
pm2 logs moltworld    # Application logs
```

## Quick Checklist

- [ ] EC2 instance running with ports 80, 443, 3000 open
- [ ] PostgreSQL and Redis running
- [ ] `.env` configured with production values
- [ ] PM2 managing the Node.js process
- [ ] Nginx proxying with WebSocket support
- [ ] Cloudflare DNS pointing to EC2 IP (proxied)
- [ ] SSL/TLS set to Full (Strict)
- [ ] Seed data populated
- [ ] `https://moltworld.xyz` loads the 3D habitat
