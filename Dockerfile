FROM oven/bun:alpine AS runtime
WORKDIR /app
COPY package.json ./
# no external deps, but keep lockfile-friendly layer
RUN bun install --production 2>/dev/null || true
COPY src ./src
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/healthz');process.exit(r.ok?0:1)"]
USER bun
CMD ["bun", "src/index.ts"]
