# miband-bot

[Русский](README.ru.md) | [English](README.md) | Español

Bot de Telegram self-hosted para datos de Xiaomi Fitness y Mi Band.

Sincroniza pasos, sueño, pulso, SpO2, estrés, actividad diaria, peso
y entrenamientos en archivos SQLite locales, y permite consultarlos o exportarlos
desde Telegram. No utiliza servicios externos para tus datos.

> Diseñado para un único propietario. No es un bot público ni un servicio médico.

## Funciones

- Resúmenes diarios, historial, informes semanales, tendencias, estadísticas familiares y comparaciones.
- Inicio de sesión QR de Xiaomi y sincronización manual o programada.
- Exportación CSV/ZIP desde Telegram.
- Interfaz en inglés por defecto, con ruso y español disponibles en Settings.
- Runtime Bun/TypeScript y Docker Compose.

## Inicio rápido

```
cp .env.example secrets.env
# Define TELEGRAM_BOT_TOKEN en secrets.env
bun install
bun run check
docker compose up -d --build
```

Los datos de ejecución se guardan en `./data/`. Mantén privados `secrets.env`, `data/`,
los tokens de Xiaomi, las bases SQLite y las exportaciones.

## Desarrollo

```
bun install
bun run check
bun run dev
```

El servicio expone `/healthz` y `/readyz` en el puerto `8080`.

## Licencia

[GNU GPL v3.0 o posterior](LICENSE).
