FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Bind all interfaces inside the container; publish with 127.0.0.1 on the host.
ENV HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "src/main.ts"]
