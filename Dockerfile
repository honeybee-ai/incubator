FROM node:22-slim

# Install git (waggle shell/git tools need it) and clean up
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

RUN npm install -g @honeybee-ai/incubator@latest

WORKDIR /hive

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8080/api/state').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["incubator"]
CMD ["--port=8080", "--verbose"]
