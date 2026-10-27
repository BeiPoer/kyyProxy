FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json adapter.js media.js server.js ./
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
