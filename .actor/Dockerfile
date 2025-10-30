# ---- Base image: Lightweight Alpine Linux with Node.js 22 ----
FROM node:22-alpine

# ---- Set working directory ----
WORKDIR /home/app

# ---- Copy dependency files and install ----
COPY package*.json ./
RUN npm install --omit=dev

# ---- Copy source code and actor files ----
COPY . ./

# ---- Install tini (for correct signal handling like Apify runtime) ----
RUN apk add --no-cache tini

# ---- Environment variables for Apify SDK local storages ----
ENV APIFY_DISABLE_OUTDATED_WARNING=1
ENV APIFY_LOCAL_STORAGE_DIR=/home/app/apify_storage

# ---- Create local Apify storage directories ----
RUN mkdir -p /home/app/apify_storage/key_value_stores/default \
    /home/app/apify_storage/datasets/default \
    /home/app/apify_storage/request_queues/default

# ---- Set tini as init process ----
ENTRYPOINT ["/sbin/tini", "--"]

# ---- Default command: run your actor ----
CMD ["node", "src/main.js"]
