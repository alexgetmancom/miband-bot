

# miband-bot

Español | [English](README_EN.md)

Bot de Telegram self-hosted y personal para datos de Xiaomi Fitness / Mi Band.

Recoge los pasos, el sueño, el ritmo cardíaco, SpO2, estrés, actividad diaria, peso
y los entrenamientos desde la nube de Xiaomi Fitness, los almacena en una base de datos SQLite local
y permite acceder a ellos directamente desde Telegram —
sin servicios de terceros y sin transmitir datos a terceros.

> **El proyecto está diseñado para un único propietario.**
> Este no es un bot público ni un servicio médico.

## Funcionalidades

- Visualización de los últimos pasos, sueño, ritmo cardíaco, SpO2, estrés, peso y entrenamientos en Telegram.
- Sincronización manual y automática programada.
- Actualización automática del mensaje principal fijado después de la sincronización en segundo plano.
- Almacenamiento del historial en SQLite (`data/`).
- Exportación de todas las tablas a un ZIP con archivos CSV directamente al chat.
- Implementación a través de Docker Compose.
- Escritura atómica del token de Xiaomi con permisos `0600`.
- Vinculación automática inteligente al primer usuario (lista blanca).

## Cómo funciona

```text
Mi Band → Xiaomi Fitness cloud → miband-bot → SQLite → Telegram / CSV
```

Docker Compose inicia dos procesos:

- `tracker` — sincroniza periódicamente los datos desde Xiaomi Fitness;
- `fitness-bot` — gestiona el menú de Telegram, la sincronización manual y la exportación.

Ambos procesos trabajan con el mismo directorio `./data`. La escritura concurrente
está evitada mediante un bloqueo de archivo (file lock).

## Requisitos

- Docker y Docker Compose (o Python 3.11+ instalado).
- Token de bot de Telegram de [@BotFather](https://t.me/BotFather).
- Cuenta de Xiaomi con datos de Xiaomi Fitness.

## Inicio rápido

### Método 1: Instalación sin fisuras con un clic (Recomendado)

Si aún no tienes el proyecto en tu computadora, puedes descargarlo y configurarlo automáticamente con un solo comando en la terminal:

- **macOS / Linux:**
  ```sh
  curl -fsSL https://raw.githubusercontent.com/iAlexeyRu/miband-bot/main/install.sh | bash
  ```
- **Windows (PowerShell):**
  ```powershell
  powershell -c "irm https://raw.githubusercontent.com/iAlexeyRu/miband-bot/main/install.ps1 | iex"
  ```

¡El instalador creará automáticamente la carpeta `miband-bot`, descargará y extraerá los archivos del proyecto, verificará el entorno y ejecutará la configuración interactiva!
Volver a ejecutar este mismo comando de PowerShell en una instalación ya configurada actualizará los archivos e iniciará el bot inmediatamente sin volver a ingresar el token.

---

### Método 2: Ejecución desde la carpeta descargada

Si ya clonaste el repositorio con `git clone` o descargaste el archivo ZIP manualmente:

- **macOS / Linux:**
  ```sh
  ./setup.sh
  ```
- **Windows:**
  Ejecuta el archivo `setup.bat` con un doble clic o ejecuta lo siguiente en la consola:
  ```cmd
  setup.bat
  ```

El script verificará automáticamente el entorno, te guiará paso a paso para obtener el token, creará la configuración `secrets.env`, instalará el entorno de Python (si se elige la ejecución sin Docker) y te ofrecerá iniciar el bot con un solo clic.
Después de la configuración, puedes reiniciar el bot usando `run_local.sh` en macOS/Linux o `run_local.bat` en Windows desde la carpeta `miband-bot`.

---

### Método 3: Configuración completamente manual (manual setup):

1. Copia la plantilla de configuración:
   ```sh
   cp secrets.env.example secrets.env
   ```
2. Indica tu `TELEGRAM_BOT_TOKEN` en el archivo `secrets.env`. Deja la variable `TELEGRAM_ALLOWED_USER_ID` **vacía** — el bot se vinculará automáticamente contigo en el primer inicio.
3. Inicia los contenedores de Docker:
   ```sh
   docker compose up -d --build
   ```
4. Abre a tu bot creado en Telegram y envíale el comando `/start` — el bot reconocerá tu cuenta, la vinculará como único propietario y comenzará la sincronización.

## Configuración

Todas las variables están en `secrets.env`:

| Variable                 | Predeterminado | Descripción                                |
| -------------------------- | ------------ | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | —            | Token del bot de Telegram                     |
| `TELEGRAM_ALLOWED_USER_ID` | —            | ID de usuario autorizado (déjalo vacío para vinculación automática) |
| `SYNC_INTERVAL`            | `900`        | Intervalo de sincronización en segundo plano, segundos |
| `QUERY_DURATION`           | `2`          | Profundidad de la consulta al sincronizar, días          |
| `ENABLE_FDS_SLEEP_DETAILS` | `true`       | Cargar datos detallados nocturnos de FDS   |

Las rutas de la base de datos y del estado están definidas en `compose.yaml`. Al ejecutar sin Docker
consulta `secrets.env.example`.

## Archivos de datos

Los archivos de ejecución se crean en `./data`:

| Archivo                   | Contenido                        |
| ---------------------- | --------------------------------- |
| `token_<id>.json`      | Token de autenticación de Xiaomi (**secreto**) |
| `miband_<id>.db`       | Base de datos SQLite con datos de salud      |
| `status_<id>.json`     | Último estado de sincronización    |
| `allowed_user.id`      | ID del propietario vinculado         |
| `fitness_bot_state.db` | Estado interno del menú de Telegram |
| `sync_<id>.lock`       | Archivo de bloqueo de sincronización           |

`secrets.env`, `data/`, `*.db`, `token*.json` y `status*.json`
están agregados a `.gitignore` — no los commitees.

## Comandos

| Comando   | Acción                              |
| --------- | ------------------------------------- |
| `/start`  | Abrir el menú o iniciar el inicio de sesión de Xiaomi |
| `/sync`   | Iniciar una sincronización manual        |
| `/status` | Mostrar el estado de la base de datos local     |

## Desarrollo local

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt -e mi-fitness-python
.venv/bin/python -m py_compile fitness_bot.py miband_sync.py \
    $(find miband_tracker -name '*.py' | sort)
.venv/bin/python -m pytest
.venv/bin/python -m pytest mi-fitness-python/tests/unit
.venv/bin/ruff check .
.venv/bin/python -m pip check
```

Puntos de entrada:

```sh
python -u miband_sync.py      # или: miband-sync
python -u fitness_bot.py      # или: miband-fitness-bot
```

## Solución de problemas

**El bot no responde** — verifica `TELEGRAM_BOT_TOKEN`, los registros (logs) y asegúrate de haber sido el primero en enviarle `/start` al bot para vincularlo. Si necesitas reiniciar al propietario vinculado, simplemente elimina el archivo `data/allowed_user.id` y envía `/start` nuevamente.

```sh
docker compose logs -f fitness-bot
```

**Token no encontrado** — envía `/start` y completa el flujo de inicio de sesión de Xiaomi.

**Token caducado** — inicia el inicio de sesión nuevamente desde el menú; el archivo antiguo
se puede eliminar desde `data/`.

**Sin SpO2 o detalles de sueño** — asegúrate de que estos datos se muestren
en la propia aplicación Xiaomi Fitness. La disponibilidad depende del modelo
de la pulsera y de la configuración de compartición.

**Después de una actualización de Xiaomi todo se rompió** — este es un riesgo esperado
al trabajar con una API no oficial. Revisa los issues y los logs, luego
actualiza el código o deshabilita temporalmente el módulo problemático.

## Importante: ingeniería inversa y limitaciones

`miband-bot` es un proyecto no oficial, no afiliado con Xiaomi, Zepp,
Huami o Telegram.

El acceso a los datos se implementa mediante ingeniería inversa de APIs cerrados,
por lo tanto:

- Xiaomi puede cambiar la API sin previo aviso;
- la autenticación o la sincronización pueden dejar de funcionar temporalmente;
- utiliza el proyecto solo con tus propias cuentas y datos;
- cumple con las leyes y los términos de uso de los servicios;
- los datos de la pulsera no constituyen un diagnóstico médico.

## Licencia

El proyecto se distribuye bajo la licencia [GNU GPL v3.0 o posterior](LICENSE).

El SDK `mi-fitness-python` se incluye como una copia de código fuente vendored bajo
[GNU GPL v3.0](mi-fitness-python/LICENSE). Para más detalles, consulta
[VENDORED.md](VENDORED.md).
