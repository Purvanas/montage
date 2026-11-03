# Montage

Deux outils vidéo dans une interface web : composer une mosaïque animée avec une à cinq vidéos, ou retirer des passages d’une vidéo sans installer de logiciel.

**Démo : [montage.purvanas.fr](https://montage.purvanas.fr)**

## Une composition pensée comme un vrai cadre

Le mode **Ensemble** produit un MP4 1920×1080. Les dispositions ne sont pas une simple grille générique : une vidéo occupe tout le cadre, deux se partagent l’écran, trois utilisent une grande zone et deux zones secondaires, quatre forment une grille, et la cinquième vient au centre par-dessus les quatre autres avec un liseré.

L’utilisateur choisit la durée de la vidéo la plus courte ou de la plus longue. Les sources plus courtes peuvent boucler ou laisser leur zone noire. Chaque piste audio peut être incluse séparément et plusieurs pistes sont mixées. Un titre facultatif complète le rendu.

Le mode **Couper** permet de retirer plusieurs plages, ajuster le volume et ajouter le même type de titre. Lorsque c’est possible, le serveur copie les flux compatibles pour éviter un réencodage inutile ; sinon FFmpeg produit un MP4 H.264/AAC.

## Architecture

```text
server.js          serveur HTTP, multipart en flux, file d’attente et API
lib/layouts.js     géométrie des cinq compositions
lib/render.js      analyse ffprobe et graphe FFmpeg des mosaïques
lib/cut.js         normalisation des plages et rendu des coupes
lib/title.js       validation et placement des titres
public/            interface responsive et aperçu local
test/              tests unitaires, HTTP et rendus vidéo
```

Le serveur n’a aucune dépendance npm. Le parseur multipart écrit les uploads en flux avec backpressure, limite chaque fichier à 500 Mo et n’accepte que cinq vidéos. Une seule tâche est encodée à la fois ; trois autres peuvent attendre. Les données d’un job expirent après deux heures et les dossiers abandonnés sont nettoyés plus tôt.

## Installation

Prérequis : Node.js 22+, FFmpeg et ffprobe.

```bash
cp .env.example .env
npm start
```

Les variables ne sont pas chargées automatiquement depuis `.env`. Par défaut, le serveur écoute sur `127.0.0.1:4710`. Le dossier de travail peut être placé sur un volume dédié avec `MONTAGE_DATA`.

## Limites

Une mosaïque dure au maximum trois minutes et une coupe au maximum dix minutes. Le projet cible une petite instance auto-hébergée, pas une ferme de rendu distribuée. Les fichiers passent temporairement par le serveur et ne bénéficient pas d’un chiffrement de bout en bout.

Les fontes embarquées dans `public/fonts/` sont distribuées sous SIL Open Font License ; leurs notices sont conservées à côté des fichiers. Le code du projet est sous licence MIT.
