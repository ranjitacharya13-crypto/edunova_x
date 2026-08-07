#!/usr/bin/env bash
# EduNova X - Setup Script for Mac/Linux

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting EduNova X Setup...${NC}"

# 1. Check for Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js v20+.${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}Node.js version must be v20 or higher. Current: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}Node.js version $(node -v) detected.${NC}"

# 2. Install dependencies
install_deps() {
    local dir=$1
    echo -e "${GREEN}Installing dependencies in $dir...${NC}"
    if [ -d "$dir" ]; then
        (cd "$dir" && npm install)
    else
        echo -e "${RED}Directory $dir not found, skipping.${NC}"
    fi
}

install_deps "."
install_deps "server"
install_deps "frontend"
install_deps "signaling"

# 3. Handle AI Engine dependencies (Python)
echo -e "${GREEN}Checking AI Engine dependencies...${NC}"
if command -v python3 &> /dev/null; then
    (cd ai_engine && python3 -m pip install -r requirements.txt)
elif command -v python &> /dev/null; then
    (cd ai_engine && python -m pip install -r requirements.txt)
else
    echo -e "${RED}Python not found. AI Engine dependencies must be installed manually.${NC}"
fi

# 4. Build Frontend
echo -e "${GREEN}Building Frontend...${NC}"
(cd frontend && npm run build)

# 5. Handle Sharp native dependencies (common fix)
echo -e "${GREEN}Optimizing native dependencies...${NC}"
(cd server && npm rebuild sharp)

# 6. Create .env if it doesn't exist
if [ ! -f server/.env ]; then
    echo -e "${GREEN}Creating server/.env from example...${NC}"
    cp server/.env.example server/.env || echo "PORT=4000" > server/.env
fi

echo -e "${GREEN}Setup Complete! You can now run 'edunova-x' if installed globally, or 'npm start' in the root.${NC}"
