# PilotPro — Serveur (DBS Fashion)

Application GPAO/ERP **multi-utilisateurs** à installer sur un PC qui sert de **serveur**.
Chaque utilisateur s'y connecte depuis son navigateur, et **tout le travail est enregistré
de façon centralisée** sur le serveur (base partagée). Plus de données isolées par PC.

---

## Contenu du dossier

| Élément | Rôle |
|---|---|
| `Demarrer-PilotPro.bat` | **Double-cliquez** pour démarrer le serveur |
| `Construire-EXE.bat` | Double-cliquez pour créer `PilotPro-Serveur.exe` (optionnel) |
| `server.js` | Le serveur (Node.js) |
| `public/PilotPro.html` | L'application complète |
| `data/` | Vos données partagées (créé automatiquement — **à sauvegarder !**) |

---

## Option 1 — Démarrage simple (recommandé)

1. Installez **Node.js LTS** une seule fois sur le PC-serveur : https://nodejs.org
2. Copiez ce dossier sur le PC-serveur.
3. **Double-cliquez sur `Demarrer-PilotPro.bat`**.
4. La fenêtre affiche l'adresse à donner aux utilisateurs, par exemple :

   ```
   Sur le réseau :  http://192.168.1.50:3000   ← cette adresse
   ```

5. Chaque utilisateur ouvre cette adresse dans **Chrome / Edge / Firefox** et se connecte
   (admin / admin123 au premier lancement). C'est tout.

> Laissez la fenêtre noire ouverte : elle EST le serveur. La fermer arrête le service.

## Option 2 — Sans installer Node (fichier .exe)

1. Sur une machine avec Node.js, **double-cliquez sur `Construire-EXE.bat`**.
2. Cela génère **`PilotPro-Serveur.exe`** dans ce dossier.
3. Copiez sur le PC-serveur : `PilotPro-Serveur.exe` **+ les dossiers `public` et `data`**.
4. Double-cliquez sur l'exe. Aucune installation de Node requise sur le serveur.

> L'exe a besoin des dossiers `public` (l'application) et `data` (les données) **à côté de lui**.

---

## Accès des utilisateurs sur le réseau

- Tous les postes doivent être sur le **même réseau** que le serveur.
- **Pare-feu Windows** : au premier démarrage, autorisez Node.js / le port (cliquez « Autoriser l'accès »).
  Sinon, ouvrez le port 3000 (Pare-feu Windows → Règle de trafic entrant → Port → TCP 3000 → Autoriser).
- Changer de port : `Demarrer-PilotPro.bat` puis tapez `node server.js 8080` dans une invite, ou
  définissez la variable `PORT`.

## Démarrage automatique au boot (optionnel)

- Simple : placez un raccourci de `Demarrer-PilotPro.bat` dans le dossier Démarrage de Windows
  (`Win+R` → `shell:startup`).
- Robuste (service Windows) : utilisez **NSSM** (https://nssm.cc) →
  `nssm install PilotPro "C:\chemin\node.exe" "C:\chemin\server.js"`.

---

## Sauvegarde des données

Toutes les données sont dans **`data/state.json`**. Sauvegardez ce fichier régulièrement
(copie sur clé USB, disque réseau, etc.). Pour restaurer : remplacez-le et redémarrez le serveur.
L'application garde aussi son bouton « Exporter sauvegarde (JSON) » côté utilisateur.

## Comment ça marche

- Au chargement, chaque navigateur **récupère l'état partagé** depuis le serveur.
- Pendant le travail, l'application **enregistre automatiquement** sur le serveur (toutes les
  quelques secondes, et à la fermeture). Une pastille en bas à gauche indique l'état (vert = à jour).
- Le bouton **« Synchroniser »** force un enregistrement immédiat.

> ⚠️ Limite à connaître : l'enregistrement se fait au niveau de l'espace de travail complet
> (principe « dernière écriture gagne »). C'est parfait pour une équipe qui travaille sur des
> zones différentes. Si plusieurs personnes modifient **exactement la même fiche au même instant**,
> la dernière sauvegarde prime. Pour de l'édition simultanée intensive, une version avec
> verrouillage par fiche peut être ajoutée — dites-le moi.

---

DBS Fashion — PilotPro v2
