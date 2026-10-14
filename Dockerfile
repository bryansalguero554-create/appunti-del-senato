FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# database e file caricati vanno su un disco persistente montato in /data
ENV PORT=3000 DATA_DIR=/data/db UPLOAD_DIR=/data/uploads
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
