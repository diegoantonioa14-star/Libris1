const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Autenticación
  validarLogin: (datos) => ipcRenderer.invoke('validar-login', datos),

  // Operaciones de Libros y Préstamos
  guardarLibro: (payload) => ipcRenderer.invoke('guardar-libro', payload),
  buscarLibroPorRfid: (rfid) => ipcRenderer.invoke('buscar-libro-rfid', rfid),
  procesarDevolucion: (rfid) => ipcRenderer.invoke('procesar-devolucion', rfid),
  
  // Consultas e Historiales
  obtenerLibrosDisponibles: () => ipcRenderer.invoke('obtener-libros-disponibles'),
  obtenerHistorialPrestamos: () => ipcRenderer.invoke('obtener-historial-prestamos'),

  // Eventos de Lector RFID
  onRfidLoginData: (callback) => ipcRenderer.on('rfid-login-data', (_event, value) => callback(value)),
  onRfidScanned: (callback) => ipcRenderer.on('rfid-scanned', (_event, value) => callback(value)),
  onRfidError: (callback) => ipcRenderer.on('rfid-error', (_event, value) => callback(value))
});