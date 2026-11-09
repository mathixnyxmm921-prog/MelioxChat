# Meliox

App de chat tipo WhatsApp: registro con foto ajustable, número colombiano, amigos y mensajes en tiempo real.

## Cómo correrlo

Necesitas Node.js. No hace falta instalar paquetes para el servidor.

1. En una terminal, dentro de la carpeta del proyecto:

   ```
   node server.cjs
   ```

2. Abre **http://localhost:3001**

(Opcional) Si prefieres Vite para el diseño, en otra terminal corre `npm run dev` y abre http://localhost:3000. El servidor `node server.cjs` debe seguir corriendo.

## Cómo probar el chat

1. Abre Meliox en una ventana normal y en una ventana de incógnito.
2. Registra dos cuentas con números distintos (empiezan con 3, 10 dígitos).
3. En una cuenta toca el ícono de persona con **+** y escribe el número de la otra.
4. En la otra cuenta acepta la solicitud (✓) y empiecen a chatear.

Desde otro celular conectado al mismo Wi-Fi, abre la dirección que imprime `node server.cjs` ("Desde otro celular...").

## Archivos

- `server.cjs`: servidor (usuarios, amigos, mensajes). Guarda todo en `data.json`.
- `index.html`, `styles.css`, `app.js`: la app.

## Reglas del número

Solo Colombia: empieza con **3** y tiene exactamente **10** dígitos. Se valida en la app y en el servidor.