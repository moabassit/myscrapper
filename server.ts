import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load environment variables from .env files
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Endpoint to get the API key dynamically in production
  app.get("/api/config", (req, res) => {
    // Check all possible names for the Gemini API key
    const key = process.env.GEMINI_API_KEY || 
                process.env.API_KEY || 
                process.env.VITE_GEMINI_API_KEY || 
                "";
    
    console.log(`[Config] API Key requested. Found: ${!!key}, Length: ${key.length}, Preview: ${key ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "N/A"}`);
    console.log(`[Config] Available Env Keys: ${Object.keys(process.env).filter(k => !k.includes('SECRET') && !k.includes('KEY') && !k.includes('PASS')).join(', ')}`);
    // Also check for keys that might contain 'GEMINI' or 'API'
    console.log(`[Config] Gemini/API related keys: ${Object.keys(process.env).filter(k => k.includes('GEMINI') || k.includes('API')).join(', ')}`);
    
    res.json({ 
      apiKey: key,
      keyPreview: key ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : "Not Found",
      isProduction: process.env.NODE_ENV === "production"
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
