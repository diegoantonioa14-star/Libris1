const { app: electronApp, BrowserWindow, ipcMain } = require('electron');
const express = require('express');
const cors = require('cors'); // Middleware CORS habilitado
const mysql2 = require('mysql2');
const path = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const app = express();
const PORT = 3000;

let mainWindow = null;

// MIDDLEWARES
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ================= CONFIGURACIÓN DE LA VENTANA DE ELECTRON =================
function crearVentana() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js')
        }
    });

    mainWindow.removeMenu();
    mainWindow.setMenu(null);
    mainWindow.loadURL(`http://localhost:${PORT}`);
}

// ================= CONFIGURACIÓN DEL LECTOR RFID (SERIAL) =================
function inicializarLectorRFID() {
    const port = new SerialPort({
        path: 'COM6',
        baudRate: 9600,
        autoOpen: false
    });

    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.open((err) => {
        if (err) {
            return console.error('❌ Error en el puerto serie COM6:', err.message);
        }
        console.log('✅ Conexión establecida con el lector RFID en el puerto serie COM6.');
    });

    parser.on('data', (rawData) => {
        const uid = rawData.replace(/[\r\n]/g, '').trim();

        if (uid) {
            console.log('🏷️ Tarjeta RFID escaneada:', uid);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('rfid-scanned', uid);
            }
        }
    });

    port.on('error', (err) => {
        console.error('❌ Error en tiempo de ejecución del puerto serie:', err.message);
    });
}

// ================= CONFIGURACIÓN DE LA BASE DE DATOS =================
const dbConfig = {
    host: '192.168.198.128',
    user: 'root',
    password: '', // Tu contraseña de MySQL en Ubuntu
    database: 'biblioteca_digital',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql2.createPool(dbConfig).promise();

// Inicializar la base de datos y esquemas de tablas
async function inicializarBaseDeDatos() {
    try {
        await pool.query(`CREATE DATABASE IF NOT EXISTS biblioteca_digital;`);
        console.log('🔹 Base de datos "biblioteca_digital" lista o verificada.');

        await pool.query(`USE biblioteca_digital;`);

        // Tabla: Usuarios
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tb_usuario (
                id INT AUTO_INCREMENT PRIMARY KEY,
                rfid_tarjeta VARCHAR(50) UNIQUE NULL,
                nombre VARCHAR(50) NOT NULL,
                apellido VARCHAR(50) NOT NULL,
                correo VARCHAR(100) NOT NULL UNIQUE,
                telefono VARCHAR(20),
                nickname VARCHAR(50) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('🔹 Tabla "tb_usuario" verificada con éxito.');

        // Tabla: Libros
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tb_libro (
                id INT AUTO_INCREMENT PRIMARY KEY,
                rfid_isbn VARCHAR(50) NOT NULL UNIQUE,
                titulo VARCHAR(150) NOT NULL,
                autor VARCHAR(100) NOT NULL,
                editorial VARCHAR(50),
                anio_publicacion INT,
                estado VARCHAR(20) DEFAULT 'Disponible',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('🔹 Tabla "tb_libro" verificada con éxito.');

        // Tabla: Préstamos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tb_prestamo (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_usuario INT NOT NULL,
                id_libro INT NOT NULL,
                fecha_prestamo TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                fecha_devolucion_esperada DATE NOT NULL,
                fecha_devolucion_real TIMESTAMP NULL,
                estado VARCHAR(20) DEFAULT 'Activo',
                FOREIGN KEY (id_usuario) REFERENCES tb_usuario(id) ON DELETE CASCADE,
                FOREIGN KEY (id_libro) REFERENCES tb_libro(id) ON DELETE CASCADE
            );
        `);
        console.log('🔹 Tabla "tb_prestamo" verificada con éxito.');

        // Tabla: Historial del Buzón Digital
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tb_buzon_registro (
                id INT AUTO_INCREMENT PRIMARY KEY,
                rfid_capturado VARCHAR(50) NOT NULL,
                fecha_lectura TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                procesado BOOLEAN DEFAULT FALSE
            );
        `);
        console.log('🔹 Tabla "tb_buzon_registro" verificada con éxito.');

    } catch (error) {
        console.error('❌ Error al inicializar el esquema de tablas:', error);
    }
}

// ================= HANDLERS DE IPC (ELECTRON) =================
ipcMain.handle('guardar-libro', async (event, payload) => {
    try {
        const { rfid_isbn, titulo, autor, editorial, anio } = payload;
        const query = `
            INSERT INTO biblioteca_digital.tb_libro (rfid_isbn, titulo, autor, editorial, anio_publicacion, estado)
            VALUES (?, ?, ?, ?, ?, 'Disponible');
        `;
        
        await pool.query(query, [rfid_isbn, titulo, autor, editorial || null, anio || null]);
        
        return { exito: true, mensaje: 'Libro registrado exitosamente en MySQL.' };
    } catch (error) {
        console.error('Error al insertar libro vía IPC:', error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return { exito: false, error: 'Este código RFID/ISBN ya existe en el sistema.' };
        }
        return { exito: false, error: error.message };
    }
});
// ================= ENDPOINTS DE LA API (EXPRESS) =================

// Obtener información del usuario por Nickname
app.get('/api/usuario/:nickname', async (req, res) => {
    const { nickname } = req.params;
    try {
        const [rows] = await pool.query(
            "SELECT nombre, apellido, correo, telefono, nickname, rfid_tarjeta, DATE_FORMAT(created_at, '%d/%m/%Y') AS fecha FROM biblioteca_digital.tb_usuario WHERE nickname = ?",
            [nickname]
        );

        if (rows.length > 0) {
            res.status(200).json(rows[0]);
        } else {
            res.status(404).json({ error: "Usuario no encontrado" });
        }
    } catch (error) {
        res.status(500).json({ error: "Error al obtener los datos del usuario" });
    }
});

// Vincular tarjeta RFID blanca a un alumno
app.post('/api/usuario/vincular-tarjeta', async (req, res) => {
    const { nickname, rfid_tarjeta } = req.body;

    if (!nickname || !rfid_tarjeta) {
        return res.status(400).json({ error: "Se requiere el nickname del usuario y la tarjeta RFID." });
    }

    try {
        await pool.query(
            "UPDATE biblioteca_digital.tb_usuario SET rfid_tarjeta = ? WHERE nickname = ?",
            [rfid_tarjeta, nickname]
        );
        res.status(200).json({ message: "Tarjeta blanca vinculada correctamente al usuario." });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "Esta tarjeta RFID ya pertenece a otro usuario." });
        }
        res.status(500).json({ error: "Error al vincular la tarjeta." });
    }
});

// Consultar usuario por tarjeta RFID blanca
app.get('/api/usuario/rfid/:rfid', async (req, res) => {
    const { rfid } = req.params;
    try {
        const [rows] = await pool.query(
            "SELECT id, nombre, apellido, nickname, correo FROM biblioteca_digital.tb_usuario WHERE rfid_tarjeta = ?",
            [rfid]
        );

        if (rows.length > 0) {
            res.status(200).json(rows[0]);
        } else {
            res.status(404).json({ error: "No hay ningún alumno registrado con esa tarjeta RFID." });
        }
    } catch (error) {
        res.status(500).json({ error: "Error al consultar la tarjeta de usuario." });
    }
});

// Registrar un Libro / Donativo (HTTP)
app.post('/api/libros', async (req, res) => {
    const { rfid_isbn, titulo, autor, editorial, anio } = req.body;

    if (!rfid_isbn || !titulo || !autor) {
        return res.status(400).json({ error: "El RFID/ISBN, Título y Autor son obligatorios." });
    }

    try {
        const query = `
            INSERT INTO biblioteca_digital.tb_libro (rfid_isbn, titulo, autor, editorial, anio_publicacion, estado)
            VALUES (?, ?, ?, ?, ?, ?);
        `;
        
        await pool.query(query, [
            rfid_isbn, 
            titulo, 
            autor, 
            editorial || null, 
            anio || null, 
            'Disponible'
        ]);
        
        res.status(201).json({ message: "Libro registrado con éxito en el inventario." });
    } catch (error) {
        console.error("Error al insertar libro:", error);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: "Este código RFID o ISBN ya está registrado." });
        }
        
        res.status(500).json({ error: error.message || "Error interno al guardar." });
    }
});

// Obtener libros con estado 'Disponible'
app.get('/api/libros/disponibles', async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT rfid_isbn, titulo, autor, editorial, anio_publicacion FROM biblioteca_digital.tb_libro WHERE estado = 'Disponible'"
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error("Error al obtener disponibles:", error);
        res.status(500).json({ error: "Error al cargar el catálogo disponible." });
    }
});

// Registrar un Préstamo
app.post('/api/prestamos', async (req, res) => {
    const { rfid_libro, rfid_alumno, nickname_alumno, dias } = req.body;

    if (!rfid_libro || (!rfid_alumno && !nickname_alumno)) {
        return res.status(400).json({ error: "Es necesario el código del libro y la tarjeta RFID o nickname del alumno." });
    }

    try {
        const [libros] = await pool.query(
            "SELECT id, estado FROM biblioteca_digital.tb_libro WHERE rfid_isbn = ?",
            [rfid_libro]
        );

        if (libros.length === 0) {
            return res.status(404).json({ error: "El libro con ese código RFID/ISBN no existe." });
        }

        if (libros[0].estado !== 'Disponible') {
            return res.status(400).json({ error: "Este libro ya se encuentra prestado." });
        }

        const id_libro = libros[0].id;

        let usuarios = [];
        if (rfid_alumno) {
            [usuarios] = await pool.query(
                "SELECT id, nombre, apellido FROM biblioteca_digital.tb_usuario WHERE rfid_tarjeta = ?",
                [rfid_alumno]
            );
        } else {
            [usuarios] = await pool.query(
                "SELECT id, nombre, apellido FROM biblioteca_digital.tb_usuario WHERE nickname = ?",
                [nickname_alumno]
            );
        }

        if (usuarios.length === 0) {
            return res.status(404).json({ error: "El alumno escaneado no está registrado en el sistema." });
        }

        const usuarioEncontrado = usuarios[0];
        const id_usuario = usuarioEncontrado.id;
        const diasVigencia = parseInt(dias) || 7;

        const queryPrestamo = `
            INSERT INTO biblioteca_digital.tb_prestamo
            (id_usuario, id_libro, fecha_prestamo, fecha_devolucion_esperada, estado)
            VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), 'Activo');
        `;
        await pool.query(queryPrestamo, [id_usuario, id_libro, diasVigencia]);

        await pool.query(
            "UPDATE biblioteca_digital.tb_libro SET estado = 'Prestado' WHERE id = ?",
            [id_libro]
        );

        res.status(201).json({ 
            message: `Préstamo registrado exitosamente a nombre de ${usuarioEncontrado.nombre} ${usuarioEncontrado.apellido}.` 
        });

    } catch (error) {
        console.error("Error al registrar préstamo:", error);
        res.status(500).json({ error: error.message || "Error interno al procesar el préstamo." });
    }
});

// Procesar Devolución Automática
app.post('/api/devoluciones', async (req, res) => {
    const { rfid_libro } = req.body;

    if (!rfid_libro) {
        return res.status(400).json({ error: "El código RFID/ISBN del libro es obligatorio." });
    }

    try {
        const [libros] = await pool.query(
            "SELECT id, titulo FROM biblioteca_digital.tb_libro WHERE rfid_isbn = ?",
            [rfid_libro]
        );

        if (libros.length === 0) {
            return res.status(404).json({ error: "El libro con ese código RFID no está registrado." });
        }

        const id_libro = libros[0].id;

        const [prestamos] = await pool.query(
            "SELECT id FROM biblioteca_digital.tb_prestamo WHERE id_libro = ? AND estado = 'Activo' LIMIT 1",
            [id_libro]
        );

        if (prestamos.length === 0) {
            return res.status(400).json({ error: "Este libro no cuenta con ningún préstamo activo en el sistema." });
        }

        const id_prestamo = prestamos[0].id;

        await pool.query(
            `UPDATE biblioteca_digital.tb_prestamo 
             SET estado = 'Devuelto', fecha_devolucion_real = NOW() 
             WHERE id = ?`,
            [id_prestamo]
        );

        await pool.query(
            "UPDATE biblioteca_digital.tb_libro SET estado = 'Disponible' WHERE id = ?",
            [id_libro]
        );

        res.status(200).json({ 
            message: `El libro "${libros[0].titulo}" ha sido devuelto e inventariado con éxito.` 
        });

    } catch (error) {
        console.error("Error al procesar devolución:", error);
        res.status(500).json({ error: error.message || "Error interno al procesar la devolución." });
    }
});

// Historial de Préstamos del Usuario
app.get('/api/prestamos/usuario/:nickname', async (req, res) => {
    const { nickname } = req.params;

    try {
        const [usuarios] = await pool.query(
            "SELECT id FROM biblioteca_digital.tb_usuario WHERE nickname = ?",
            [nickname]
        );

        if (usuarios.length === 0) {
            return res.status(404).json({ error: "Usuario no encontrado." });
        }

        const id_usuario = usuarios[0].id;

        const query = `
            SELECT 
                p.id,
                l.titulo,
                l.rfid_isbn,
                DATE_FORMAT(p.fecha_prestamo, '%d/%m/%Y') AS fecha_p,
                DATE_FORMAT(p.fecha_devolucion_esperada, '%d/%m/%Y') AS fecha_e,
                p.estado
            FROM biblioteca_digital.tb_prestamo p
            JOIN biblioteca_digital.tb_libro l ON p.id_libro = l.id
            WHERE p.id_usuario = ?
            ORDER BY p.fecha_prestamo DESC;
        `;
        
        const [rows] = await pool.query(query, [id_usuario]);
        res.status(200).json(rows);

    } catch (error) {
        console.error("Error al obtener préstamos del usuario:", error);
        res.status(500).json({ error: "Error al cargar el historial de préstamos." });
    }
});

// ================= ORQUESTADOR DE ARRANQUE =================
async function arrancarSistema() {
    await inicializarBaseDeDatos();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Servidor activo en: http://localhost:${PORT}`);
        electronApp.whenReady().then(crearVentana);
        inicializarLectorRFID();
    });
}

// Lanzar aplicación
arrancarSistema();