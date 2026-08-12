module.exports = {
  apps: [
    {
      name: "shop-mcp",
      cwd: "/opt/mcp-shop-vps",
      script: "src/server.js",
      env: {
        PORT: "8796",
        DB_PATH: "/opt/mcp-shop-vps/data/shop.db",
        AUTH_TOKEN_FILE: "/opt/mcp-shop-vps/secrets/auth_token",
        ADMIN_AUTH_TOKEN_FILE: "/opt/mcp-shop-vps/secrets/admin_auth_token",
        WEBHOOK_SECRET_FILE: "/opt/mcp-shop-vps/secrets/webhook_secret",
        PUBLIC_HOST: "shop-mcp.ardf.dev",
      },
    },
  ],
};
