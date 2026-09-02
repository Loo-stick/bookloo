// Montage du service.
//
// Ordre volontaire : en-tetes de securite, puis cookies, puis session, puis les routes.
// Les statiques sont servis sans authentification — ce ne sont que des coquilles HTML,
// toute donnee passe par une route protegee.

import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { tracer, tracerErreur } from './core/journal';
import { ouvrirMangaloo } from './db/schema';
import { assurerPremierAdmin } from './db/premier-admin';
import { attacherSession } from './auth/garde';
import { purgerSessionsExpirees } from './auth/sessions';
import { routesAuth } from './routes/auth';
import { routesLogs } from './routes/logs';
import { routesCatalogue } from './routes/catalogue';
import { routesCouverture } from './routes/couverture';
import { routesReleases } from './routes/releases';
import { routesFlux } from './routes/flux';
import { routesDebrid } from './routes/debrid';
import { routesLecture } from './routes/lecture';
import { routesCompte } from './routes/compte';
import { routesBibliotheque } from './routes/bibliotheque';
import { routesTelegram } from './routes/telegram';
import { routesZlibrary } from './routes/zlibrary';
import { routesLectureEpub } from './routes/lecture-epub';
import { routesEcoute } from './routes/ecoute';
import { routesArchive } from './routes/archive';
import { routesPresse } from './routes/presse';
import { routesLecturePdf } from './routes/lecture-pdf';
import { routesEmpreinte } from './routes/empreinte';
import { routesAdmin } from './routes/admin';
import { HOTES_IMAGES } from './catalogue/types';

async function demarrer(): Promise<void> {
  const db = ouvrirMangaloo();

  const admin = await assurerPremierAdmin(db);
  if (admin) {
    // Affiche UNE SEULE FOIS, au premier demarrage. Il n'y a pas d'inscription
    // ouverte : sur une application exposee sur Internet, un formulaire public est une
    // invitation.
    console.log('');
    console.log('  ┌─ Premier demarrage ────────────────────────────────');
    console.log(`  │  identifiant : ${admin.login}`);
    console.log(`  │  mot de passe : ${admin.motDePasse}`);
    console.log('  │  Notez-le : il ne sera plus jamais affiche.');
    console.log('  └────────────────────────────────────────────────────');
    console.log('');
  }

  const app = express();
  app.disable('x-powered-by');
  // Derriere cloudflared PUIS Apache : deux sauts. Mal regle, toutes les requetes
  // semblent venir de 127.0.0.1 et la limitation par IP ne limite plus rien — un
  // attaquant partage alors le meme compteur que l'utilisateur legitime.
  //
  // La valeur depend de la chaine reelle et doit etre VERIFIEE apres deploiement :
  // `GET /api/moi` rend l'adresse vue par Express, qui doit etre celle du client.
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 2));

  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
        // Les couvertures des catalogues sont les SEULES origines externes autorisees,
        // et uniquement en images. La liste est construite a partir de `HOTES_IMAGES` :
        // ajouter un catalogue sans etendre la politique bloquerait ses couvertures en
        // silence, ce qui est deja arrive avec ComicVine.
        `img-src 'self' ${Object.values(HOTES_IMAGES).flat().join(' ')} data:; ` +
        "script-src 'self'; style-src 'self'; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(attacherSession(db));

  app.use(routesAuth(db));
  app.use(routesLogs());
  app.use(routesCatalogue());
  app.use(routesCouverture());
  app.use(routesReleases(db));
  app.use(routesFlux(db));
  app.use(routesDebrid(db));
  app.use(routesLecture(db));
  app.use(routesCompte(db));
  app.use(routesBibliotheque(db));
  app.use(routesTelegram());
  app.use(routesZlibrary(db));
  app.use(routesLectureEpub(db));
  app.use(routesEcoute(db));
  app.use(routesArchive(db));
  app.use(routesPresse(db));
  app.use(routesLecturePdf(db));
  app.use(routesEmpreinte());
  app.use(routesAdmin(db));

  app.get('/sante', (_req, res) => res.json({ ok: true }));

  const dossierWeb = path.join(__dirname, 'web');
  app.use(express.static(dossierWeb, { extensions: ['html'] }));
  app.get('/', (_req, res) => res.sendFile(path.join(dossierWeb, 'index.html')));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    tracerErreur('HTTP', err);
    res.status(500).json({ erreur: 'erreur interne' });
  });

  const port = Number(process.env.PORT || 8480);
  const serveur = app.listen(port, () => tracer('Book Loo Store', `ecoute sur :${port}`));

  // Les sessions expirees ne se nettoient pas toutes seules, et chacune retient une
  // entree en memoire.
  const purge = setInterval(() => {
    const n = purgerSessionsExpirees(db);
    if (n > 0) tracer('Sessions', `${n} session(s) expiree(s) purgee(s)`);
  }, 60 * 60 * 1000);
  purge.unref();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      tracer('Book Loo Store', 'arret demande');
      serveur.close(() => process.exit(0));
    });
  }
}

demarrer().catch((e) => {
  tracerErreur('Book Loo Store', e);
  process.exit(1);
});
