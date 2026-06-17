FROM node:20-alpine

# Pin the container clock to Amsterdam. The availability pipeline builds and
# compares naive local datetimes (Mindbody returns Amsterdam-local times), so a
# UTC server clock shifts/drops valid slots. tzdata is required on alpine or the
# TZ env is a no-op.
RUN apk add --no-cache tzdata
ENV TZ=Europe/Amsterdam

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
