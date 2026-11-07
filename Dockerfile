FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true
COPY . .
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
