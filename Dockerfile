FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY README.md ./

ENV PORT=7005

EXPOSE 7005

CMD ["node", "index.js"]
