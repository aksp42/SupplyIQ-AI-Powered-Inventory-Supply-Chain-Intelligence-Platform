#!/bin/sh
# Create Docker Compose .env file with all required environment variables
# This is used by the integration test job

cat > .env <<'EOF'
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
JWT_SECRET=${JWT_SECRET}
NODE_ENV=production
PORT=4000
FIREBASE_API_KEY=ci-placeholder-key
BCRYPT_ROUNDS=10
JWT_EXPIRES_IN=7d
DEMO_EMAIL=${DEMO_EMAIL}
DEMO_STORE_ID=${DEMO_STORE_ID}
DEMO_PASSWORD=${DEMO_PASSWORD}
EOF