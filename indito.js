const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const { engine } = require('express-handlebars');


require("dotenv").config();
const basePath = process.env.BASE_PATH ?? "";


const app = express();
app.locals.basePath = basePath;
const port = 3000;


// 1.1 Body Parser és Static fájlok
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1.2 Session bekapcsolása (Ennek ELŐBB kell lennie, mint a felhasználó kezelésnek!)
app.use(session({
    secret: 'titkos_lotto_kulcs',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Fejlesztéshez false, hogy működjön sima HTTP-n
}));

// 1.3 Handlebars beállítása (Biztonságos helperrel)
app.engine('hbs', engine({
    extname: '.hbs',
    defaultLayout: 'main',
    helpers: {
        // Javított egyenlőség vizsgáló: Kezeli, ha az egyik érték hiányzik (undefined)
        eq: (a, b) => {
            if (a === undefined || b === undefined) return false;
            return a === b;
        },
        formatDate: (date) => {
            if (!date) return "";
            return new Date(date).toLocaleString('hu-HU');
        }
    }
}));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) console.error('DB Hiba (Nem tudott csatlakozni): ' + err.message);
    else console.log('Sikeres csatlakozás az adatbázishoz.');
});

// --- 3. MIDDLEWARE (Segédfüggvények) ---

// 3.1 Globális felhasználó változó beállítása
// (Ez teszi lehetővé, hogy a menüben látszódjon a név)
app.use((req, res, next) => {
    // Ha nincs session (pl. hiba van), akkor legyen null
    if (!req.session) {
        res.locals.user = null;
    } else {
        res.locals.user = req.session.user || null;
    }
    next();
});

// 3.2 Védelmi funkciók
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect(basePath +'/login');
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send('Nincs jogosultságod! <a href="/">Vissza a főoldalra</a>');
}

// --- 4. ÚTVONALAK ---

// Főoldal - ITT NEM LEHET 'isAuthenticated', mert akkor senki nem látja!
app.get(basePath + '/', (req, res) => {
    res.render('index', { title: 'Főoldal - SzerencseAdat Kft.' });
});

// Adatbázis menü (Mindenki láthatja)
app.get(basePath +'/adatbazis', (req, res) => {
    const sql = `
        SELECT huzas.ev, huzas.het, huzott.szam, nyeremeny.talalat, nyeremeny.ertek 
        FROM huzas 
        LEFT JOIN huzott ON huzas.id = huzott.huzasid 
        LEFT JOIN nyeremeny ON huzas.id = nyeremeny.huzasid
        ORDER BY huzas.ev DESC, huzas.het DESC
        LIMIT 50
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error(err);
            return res.render('database', { title: 'Adatbázis Hiba', huzasok: [] });
        }
        const plainResults = JSON.parse(JSON.stringify(results));
        res.render('database', { title: 'Eredmények', huzasok: plainResults });
    });
});

// Kapcsolat
app.get(basePath +'/kapcsolat', (req, res) => {
    res.render('contact', { title: 'Kapcsolat' });
});

app.post(basePath +'/kapcsolat', (req, res) => {
    const { name, email, text } = req.body;
    db.query('INSERT INTO messages (sender_name, email, message, created_at) VALUES (?, ?, ?, NOW())',
        [name, email, text], (err) => {
            res.render('contact', { title: 'Kapcsolat', msg: err ? 'Hiba történt!' : 'Üzenet elküldve!' });
        });
});

// Üzenetek (Csak belépve!)
app.get(basePath +'/uzenetek', isAuthenticated, (req, res) => {
    db.query('SELECT * FROM messages ORDER BY created_at DESC', (err, results) => {
        const plainResults = JSON.parse(JSON.stringify(results || []));
        res.render('messages', { title: 'Üzenetek', messages: plainResults });
    });
});



// -- CRUD ADMIN (Minden egy helyen) --

// 1. Lista megjelenítése (Összetett lekérdezés: Húzások + Számok + Nyeremények)
app.get(basePath +'/crud', isAuthenticated, isAdmin, (req, res) => {
    // 1. Lekérjük az összes húzást
    db.query('SELECT * FROM huzas ORDER BY ev DESC, het DESC', (err, draws) => {
        if (err) return res.send("Hiba: " + err.message);

        // 2. Lekérjük az összes kihúzott számot
        db.query('SELECT * FROM huzott ORDER BY szam ASC', (err, numbers) => {
            if (err) return res.send("Hiba: " + err.message);

            // 3. Lekérjük az összes nyereményt
            db.query('SELECT * FROM nyeremeny ORDER BY talalat DESC', (err, prizes) => {
                if (err) return res.send("Hiba: " + err.message);

                // 4. Összerakjuk az adatokat memóriában (hogy a HBS sablonban könnyű legyen)
                // Minden húzáshoz hozzácsatoljuk a saját számait és nyereményeit
                const drawsList = JSON.parse(JSON.stringify(draws));
                const numbersList = JSON.parse(JSON.stringify(numbers));
                const prizesList = JSON.parse(JSON.stringify(prizes));

                const mappedResults = drawsList.map(draw => {
                    return {
                        ...draw, // A húzás adatai (id, ev, het)
                        // Hozzászűrjük a hozzá tartozó számokat:
                        numbers: numbersList.filter(n => n.huzasid === draw.id),
                        // Hozzászűrjük a hozzá tartozó nyereményeket:
                        prizes: prizesList.filter(p => p.huzasid === draw.id)
                    };
                });

                res.render('crud', { title: 'CRUD Admin', items: mappedResults });
            });
        });
    });
});

// 2. Új Húzás Hozzáadása (Év, Hét)
app.post(basePath +'/crud/add', isAuthenticated, isAdmin, (req, res) => {
    const { ev, het } = req.body;
    if (!ev || !het) return res.send("Hiányzó adatok!");

    db.query('INSERT INTO huzas (ev, het) VALUES (?, ?)', [ev, het], (err) => {
        if (err) return res.send("Mentési hiba: " + err.message);
        res.redirect(basePath +'/crud');
    });
});

// 3. Húzás Törlése (Cascade miatt a számok is törlődnek)
app.get(basePath +'/crud/delete/:id', isAuthenticated, isAdmin, (req, res) => {
    db.query('DELETE FROM huzas WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.send("Hiba törlésnél: " + err.message);
        res.redirect(basePath +'/crud');
    });
});

// 4. ÚJ SZÁM HOZZÁADÁSA (Közvetlenül a listáról)
app.post(basePath +'/crud/add-number/:id', isAuthenticated, isAdmin, (req, res) => {
    const { szam } = req.body;
    db.query('INSERT INTO huzott (huzasid, szam) VALUES (?, ?)', [req.params.id, szam], (err) => {
        if(err) console.log(err);
        res.redirect(basePath +'/crud'); // Vissza a listára
    });
});

// 5. SZÁM TÖRLÉSE
app.get(basePath +'/crud/delete-number/:id', isAuthenticated, isAdmin, (req, res) => {
    db.query('DELETE FROM huzott WHERE id = ?', [req.params.id], () => {
        res.redirect(basePath +'/crud');
    });
});

// 6. ÚJ NYEREMÉNY HOZZÁADÁSA (Közvetlenül a listáról)
app.post(basePath +'/crud/add-prize/:id', isAuthenticated, isAdmin, (req, res) => {
    const { talalat, darab, ertek } = req.body;
    db.query('INSERT INTO nyeremeny (huzasid, talalat, darab, ertek) VALUES (?, ?, ?, ?)',
        [req.params.id, talalat, darab, ertek], (err) => {
            if(err) console.log(err);
            res.redirect(basePath +'/crud');
        });
});

// 7. NYEREMÉNY TÖRLÉSE
app.get(basePath +'/crud/delete-prize/:id', isAuthenticated, isAdmin, (req, res) => {
    db.query('DELETE FROM nyeremeny WHERE id = ?', [req.params.id], () => {
        res.redirect(basePath +'/crud');
    });
});
// Autentikáció
app.get(basePath +'/login', (req, res) => res.render('login', { title: 'Belépés' }));
app.post(basePath +'/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
        if (results && results.length > 0 && results[0].password === password) {
            req.session.user = results[0];
            res.redirect(basePath +'/');
        } else {
            res.render('login', { title: 'Belépés', error: 'Hibás adatok' });
        }
    });
});

app.get(basePath +'/logout', (req, res) => {
    req.session.destroy();
    res.redirect(basePath +'/');
});

app.get(basePath +'/register', (req, res) => res.render('register', { title: 'Regisztráció' }));
app.post(basePath +'/register', (req, res) => {
    db.query('INSERT INTO users (username, password, role) VALUES (?, ?, "visitor")',
        [req.body.username, req.body.password],
        () => res.redirect(basePath +'/login'));
});

// Szerver indítása
app.listen(port, () => console.log(`SZERVER FUT: http://localhost:${port}`));