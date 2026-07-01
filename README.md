# Coluncer — Sitio Web

Sitio estático (HTML/CSS/JS en un solo archivo) para Coluncer.

## Estructura
```
.
├── index.html      # Sitio completo (HTML + CSS + JS embebidos)
├── render.yaml      # Configuración de despliegue para Render
└── README.md
```

## 1. Subir a GitHub

Desde esta carpeta, en tu terminal local:

```bash
git init
git add .
git commit -m "Sitio Coluncer"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/coluncer-sitio.git
git push -u origin main
```

(Antes crea el repo vacío en GitHub, sin README, en https://github.com/new)

## 2. Conectar con Render

**Opción A — Automática con render.yaml (recomendada):**
1. Entra a https://dashboard.render.com
2. Click en "New +" → "Blueprint"
3. Conecta tu cuenta de GitHub y selecciona el repo `coluncer-sitio`
4. Render detecta `render.yaml` automáticamente y crea el servicio
5. Click en "Apply" y espera el deploy

**Opción B — Manual:**
1. En Render Dashboard: "New +" → "Static Site"
2. Conecta el repo `coluncer-sitio`
3. Configura:
   - **Build Command:** (dejar vacío)
   - **Publish Directory:** `.`
4. Click "Create Static Site"

Cada `git push` a `main` vuelve a desplegar el sitio automáticamente.

## 3. Dominio propio (opcional)
En Render: Settings → Custom Domains → agrega `coluncer.com` y sigue las instrucciones de DNS (registro CNAME o A que te indique Render).
