# Justfile for chatson

# Start development server with LAN access
dev:
    vite --host

# Preview production build with LAN access
preview:
    vite preview --host

# Build for production (output → docs/)
build:
    vite build
