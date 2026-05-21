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
   - `AUTH_TOKEN` : protège les routes `/api/*` (header `Authorization: Bearer <token>`)
   - `RESET_AUTH` : au redémarrage, supprime la session (`1`, `2`, `all` ou `1,2`) puis affiche un nouveau QR

### Réinitialiser la session WhatsApp (session fantôme)

Si les messages n'apparaissent pas sur le téléphone alors que le dashboard indique « connecté » :

1. **Dashboard** → onglet Connexion → bouton **Reset Auth — Nouveau QR**
2. Ou en ligne de commande (remplacez par **votre** URL Railway publique) :

```bash
curl https://VOTRE-APP.up.railway.app/api/health
curl -X POST https://VOTRE-APP.up.railway.app/api/1/reset-auth
```

Si `GET /api/health` renvoie aussi `Not Found`, le déploiement actif n'a pas encore cette version — relancez un deploy depuis GitHub.

Pour forcer un reset au prochain redémarrage sans shell : variable `RESET_AUTH=1`, redéployez, puis retirez la variable.
6. Cliquez **Deploy** → attendez le build (~3 min)
7. Ouvrez l'URL publique Railway → scannez le QR code
