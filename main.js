const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const mysql = require('mysql2');

let mainWindow;

// 1. Conexión con MySQL
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '', 
  database: 'biblioteca_digital'
});

db.connect((err) => {
  if (err) {
    console.error('❌ Error conectando a MySQL:', err.message);
  } else {
    console.log('✅ Conectado a MySQL (biblioteca_digital) exitosamente');
  }
});

// 2. Ventana Principal
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Descomentar si necesitas inspeccionar la consola de Electron
  // mainWindow.webContents.openDevTools(); 
}

// 3. Manejadores IPC (Comunicación HTML <-> Electron <-> MySQL)

// A. Guardar un nuevo libro (Donativos / Altas)
ipcMain.handle('guardar-libro', async (event, payload) => {
  return new Promise((resolve) => {
    const { rfid_isbn, titulo, autor, editorial, anio } = payload;

    const sql = 'INSERT INTO tb_libro (rfid_isbn, titulo, autor, editorial, anio_publicacion) VALUES (?, ?, ?, ?, ?)';

    db.query(sql, [rfid_isbn, titulo, autor, editorial, anio], (err, result) => {
      if (err) {
        console.error('❌ Error al guardar libro en MySQL:', err.message);
        resolve({ exito: false, mensaje: err.message });
      } else {
        console.log('✅ Libro registrado exitosamente con ID:', result.insertId);
        resolve({ exito: true, mensaje: 'Material registrado con éxito', insertId: result.insertId });
      }
    });
  });
});

// B. Obtener libros disponibles para préstamo
ipcMain.handle('obtener-libros-disponibles', async () => {
  return new Promise((resolve) => {
    const sql = 'SELECT * FROM tb_libro ORDER BY id DESC';
    db.query(sql, (err, results) => {
      if (err) {
        console.error('❌ Error al obtener libros:', err.message);
        resolve({ exito: false, mensaje: err.message, libros: [] });
      } else {
        console.log(`📚 Libros encontrados en DB: ${results.length}`);
        resolve({ exito: true, libros: results });
      }
    });
  });
});

// C. Buscar información de un libro por su RFID/ISBN
ipcMain.handle('buscar-libro-rfid', async (event, rfid) => {
  return new Promise((resolve) => {
    const sql = 'SELECT * FROM tb_libro WHERE REPLACE(rfid_isbn, " ", "") = REPLACE(?, " ", "")';
    db.query(sql, [rfid], (err, results) => {
      if (err) {
        console.error('❌ Error buscando libro:', err.message);
        resolve({ exito: false, mensaje: err.message });
      } else if (results.length > 0) {
        resolve({ exito: true, libro: results[0] });
      } else {
        resolve({ exito: false, mensaje: 'Material no encontrado en inventario.' });
      }
    });
  });
});

// D. Procesar devolución de libro
ipcMain.handle('procesar-devolucion', async (event, rfid) => {
  return new Promise((resolve) => {
    const sql = 'UPDATE tb_libro SET estado = "Disponible" WHERE REPLACE(rfid_isbn, " ", "") = REPLACE(?, " ", "")';
    
    db.query(sql, [rfid], (err, result) => {
      if (err) {
        console.error('❌ Error al procesar devolución:', err.message);
        resolve({ exito: false, mensaje: err.message });
      } else if (result.affectedRows > 0) {
        resolve({ exito: true, mensaje: 'Devolución registrada con éxito.' });
      } else {
        resolve({ exito: false, mensaje: 'El libro no se encuentra en el inventario.' });
      }
    });
  });
});

// E. Obtener el historial de préstamos
ipcMain.handle('obtener-historial-prestamos', async () => {
  return new Promise((resolve) => {
    const sql = `
      SELECT p.*, l.titulo 
      FROM tb_prestamo p 
      LEFT JOIN tb_libro l ON REPLACE(p.rfid_isbn, ' ', '') = REPLACE(l.rfid_isbn, ' ', '') 
      ORDER BY p.id DESC
    `;
    
    db.query(sql, (err, results) => {
      if (err) {
        db.query('SELECT * FROM tb_prestamo ORDER BY id DESC', (errBasic, resultsBasic) => {
          if (errBasic) {
            console.warn('⚠️ No se pudo obtener el historial:', errBasic.message);
            resolve({ exito: false, prestamos: [] });
          } else {
            resolve({ exito: true, prestamos: resultsBasic });
          }
        });
      } else {
        resolve({ exito: true, prestamos: results });
      }
    });
  });
});

// F. Validar Login por Formulario (Soporta columna 'contrasena' o 'password')
// F. Validar Login por Formulario
// F. Validar Login por Formulario
ipcMain.handle('validar-login', async (event, datos) => {
  return new Promise((resolve) => {
    const { usuario, password } = datos;

    // Buscamos directamente por nickname y password
    const sql = 'SELECT * FROM tb_usuario WHERE nickname = ? AND password = ?';

    db.query(sql, [usuario, password], (err, results) => {
      if (err) {
        console.error('❌ Error en login SQL:', err.message);
        return resolve({ exito: false, mensaje: err.message }); // Muestra el mensaje exacto si vuelve a fallar
      }

      if (results.length > 0) {
        const usuarioEncontrado = results[0];
        console.log(`✅ Login exitoso: ${usuarioEncontrado.nickname}`);
        resolve({
          exito: true,
          mensaje: 'Inicio de sesión correcto.',
          usuario: usuarioEncontrado
        });
      } else {
        console.warn(`⚠️ Intento fallido de login para: ${usuario}`);
        resolve({
          exito: false,
          mensaje: 'Usuario o contraseña incorrectos.'
        });
      }
    });
  });
});

// 4. Conexión Serial Arduino
// 4. Conexión Serial Arduino
async function conectarArduino() {
  setTimeout(async () => {
    try {
      const puertos = await SerialPort.list();
      console.log('🔌 Puertos detectados:', puertos.map(p => p.path));

      const puertoArduino = puertos.find(p => 
        p.path === 'COM6' || 
        (p.manufacturer && p.manufacturer.toLowerCase().includes('arduino')) ||
        (p.vendorId && p.vendorId.toLowerCase().includes('2341'))
      );

      const pathPuerto = puertoArduino ? puertoArduino.path : 'COM6';

      const puerto = new SerialPort({
        path: pathPuerto,
        baudRate: 9600,
        autoOpen: false
      });

      const parser = puerto.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      puerto.open((err) => {
        if (err) {
          console.error(`❌ Error abriendo ${pathPuerto}:`, err.message);
          return;
        }
        console.log(`✅ Arduino conectado correctamente en ${pathPuerto}`);
      });

      parser.on('data', (data) => {
        const textoRecibido = data.trim();

        if (textoRecibido.length > 0) {
          if (textoRecibido.includes('Iniciando') || textoRecibido.includes('Firmware') || textoRecibido.includes('Modulo listo')) {
            return;
          }

          const uidLimpio = textoRecibido.replace('Card UID:', '').trim();
          console.log('💳 UID procesado desde Arduino:', uidLimpio);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rfid-scanned', uidLimpio);

            const sql = 'SELECT nickname, password FROM tb_usuario WHERE REPLACE(rfid_uid, " ", "") = REPLACE(?, " ", "")';

            db.query(sql, [uidLimpio], (err, results) => {
              if (err) {
                console.error('❌ Error SQL RFID:', err.message);
                return;
              }

              if (results.length > 0) {
                const usuario = results[0];
                console.log('✅ Usuario encontrado:', usuario.nickname);

                mainWindow.webContents.send('rfid-login-data', {
                  nickname: usuario.nickname,
                  password: usuario.password
                });
              } else {
                console.warn('⚠️ Tarjeta no registrada en tb_usuario');
                mainWindow.webContents.send('rfid-error', 'Tarjeta no registrada en el sistema');
              }
            });
          }
        }
      });

      puerto.on('error', (err) => {
        console.error('❌ Error en el puerto serial:', err.message);
      });
    } catch (error) {
      console.error('❌ Excepción al conectar Arduino:', error.message);
    }
  }, 1000);
}

// 5. Eventos de la Aplicación
app.whenReady().then(() => {
  createWindow();
  conectarArduino();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

f// 4. Conexión Serial Arduino
async function conectarArduino() {
  setTimeout(async () => {
    try {
      // Listar puertos disponibles en el sistema
      const puertos = await SerialPort.list();
      console.log('🔌 Puertos detectados:', puertos.map(p => p.path));

      // Buscar COM6 o detectar automáticamente por Vendor ID / Manufacturer
      const puertoArduino = puertos.find(p => 
        p.path === 'COM6' || 
        (p.manufacturer && p.manufacturer.toLowerCase().includes('arduino')) ||
        (p.vendorId && p.vendorId.toLowerCase().includes('2341'))
      );

      const pathPuerto = puertoArduino ? puertoArduino.path : 'COM6';

      const puerto = new SerialPort({
        path: pathPuerto,
        baudRate: 9600,
        autoOpen: false
      });

      const parser = puerto.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      puerto.open((err) => {
        if (err) {
          console.error(`❌ Error abriendo ${pathPuerto}:`, err.message);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rfid-error', `Error en puerto ${pathPuerto}: ${err.message}`);
          }
          return;
        }
        console.log(`✅ Arduino conectado correctamente en ${pathPuerto}`);
      });

      parser.on('data', (data) => {
        const textoRecibido = data.trim();

        if (textoRecibido.length > 0) {
          if (textoRecibido.includes('Iniciando') || textoRecibido.includes('Firmware') || textoRecibido.includes('Modulo listo')) {
            return;
          }

          const uidLimpio = textoRecibido.replace('Card UID:', '').trim();
          console.log('💳 UID procesado desde Arduino:', uidLimpio);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rfid-scanned', uidLimpio);

            const sql = 'SELECT nickname, password FROM tb_usuario WHERE REPLACE(rfid_uid, " ", "") = REPLACE(?, " ", "")';

            db.query(sql, [uidLimpio], (err, results) => {
              if (err) {
                console.error('❌ Error SQL RFID:', err.message);
                return;
              }

              if (results.length > 0) {
                const usuario = results[0];
                console.log('✅ Usuario encontrado:', usuario.nickname);

                mainWindow.webContents.send('rfid-login-data', {
                  nickname: usuario.nickname,
                  password: usuario.password
                });
              } else {
                console.warn('⚠️ Tarjeta no registrada en tb_usuario');
                mainWindow.webContents.send('rfid-error', 'Tarjeta no registrada en el sistema');
              }
            });
          }
        }
      });

      puerto.on('error', (err) => {
        console.error('❌ Error en el puerto serial:', err.message);
      });
    } catch (error) {
      console.error('❌ Excepción al conectar Arduino:', error.message);
    }
  }, 1000);
}

// 5. Eventos de la Aplicación
app.whenReady().then(() => {
  createWindow();
  conectarArduino();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});