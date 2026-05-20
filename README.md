# WhatsApp Manager

Dashboard web pour gérer l'envoi de messages WhatsApp, avec import/export CSV, anti-ban, et hébergement Railway.

## Démarrage local

```bash
npm install
npm start
# Ouvrez http://localhost:3000
```

## Déploiement sur Railway

1. Connectez-vous sur [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo** → sélectionnez `whatsapp-manager`
3. Railway détecte automatiquement le Dockerfile
4. Allez dans **Settings → Volumes** et ajoutez :
   - `/app/.wwebjs_auth` → session WhatsApp persistante
   - `/app/data` → sauvegarde de la queue
5. Variables d'environnement optionnelles :
   - `MIN_DELAY_S` : délai minimum (défaut: 45)
   - `MAX_DELAY_S` : délai maximum (défaut: 120)
6. Cliquez **Deploy** → attendez le build (~3 min)
7. Ouvrez l'URL publique Railway → scannez le QR code
