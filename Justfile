# Justfile for chatson

vite := "node ./node_modules/vite/bin/vite.js"

# Start development server with LAN access
dev:
    {{vite}} --host

# Preview production build with LAN access
preview:
    {{vite}} preview --host

# Build for production (output → docs/)
build:
    {{vite}} build
