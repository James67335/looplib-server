FROM node:18-slim

# Install ffmpeg, curl, python3, pip
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp via pip (always pulls latest)
RUN pip3 install -U yt-dlp --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]