FROM node:18-slim

# Install ffmpeg, curl, python3, pip
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp via pip with curl-cffi (needed for TikTok impersonation)
RUN pip3 install -U "yt-dlp[default,curl-cffi]" --break-system-packages

# Build-time check: show yt-dlp version and available impersonation targets
RUN yt-dlp --version && yt-dlp --list-impersonate-targets

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]