# Saathi v2 — Project Context

## Project Overview
Saathi v2 is a political contact management and briefing system designed for team coordination. It helps in ranking contacts based on their influence and the necessity of engagement using a custom **PPS (Priority & Proximity Score)** algorithm. The system includes a dashboard for team members, a news submission desk for field correspondents, and an automated WhatsApp briefing service.

### Main Technologies
- **Runtime:** Node.js (>= 18.0.0)
- **Framework:** Express.js (ES Modules)
- **WhatsApp Integration:** `@whiskeysockets/baileys` (Headless WhatsApp Web)
- **Database:** Local JSON file (`data/db.json`)
- **Search:** `fuse.js` for fuzzy search on contacts
- **Deployment:** Pre-configured for Railway (using `railway.toml` and Nixpacks)

## Architecture
- **`server/`**: Contains the core logic.
    - `index.js`: Express server, REST API endpoints, and brief generation logic.
    - `whatsapp.js`: Manages the WhatsApp socket connection, authentication (multi-file auth state), and messaging.
- **`public/`**: Static frontend files.
    - `index.html`: The main dashboard for the team.
    - `news.html`: A simplified form for journalists to submit news.
- **`scripts/`**: Maintenance and setup scripts.
    - `setup_db.js`: Processes raw Excel contact data and generates the initial `db.json` with computed PPS scores.
- **`data/`**: Persistent storage.
    - `db.json`: The live database.
    - `wa_auth/`: Folder created at runtime to store WhatsApp session tokens.

## Building and Running

### Prerequisites
- Node.js v18 or higher.

### Commands
- **Install Dependencies:** `npm install`
- **Initialize/Seed Database:** `npm run setup-db`
    - *Note: Check `scripts/setup_db.js` for hardcoded Excel input paths if seeding fails.*
- **Start Server:** `npm start`
    - The server starts on port `3000` (or the `PORT` environment variable).
    - On first run, a QR code will appear in the terminal for WhatsApp linking.

### Testing
No formal test suite (Jest/Mocha) is currently present. Testing is performed manually by verifying API responses and UI functionality.

## Development Conventions

### Data Persistence
- The project uses a simple JSON-based database at `data/db.json`.
- On Railway, it is recommended to mount a persistent volume at the path specified by `RAILWAY_VOLUME_MOUNT_PATH` to ensure `db.json` and WhatsApp sessions persist across deployments.

### API Endpoints
- `GET /api/dashboard`: Aggregated data for the main view.
- `GET /api/contacts`: Searchable and filterable contact list.
- `POST /api/schedule`: Add upcoming events and identify nearby contacts.
- `POST /api/news`: Submit journalist news items.
- `POST /api/send-brief`: Triggers the WhatsApp brief delivery.
- `GET /api/wa-status`: Check if the WhatsApp bot is connected.

### WhatsApp Bot
- Uses the Baileys library. Authentication state is stored in `data/wa_auth/`.
- If the session is logged out, the `wa_auth` folder must be cleared to generate a new QR code.

## TODOs & Missing Items
- [ ] Add unit tests for the PPS scoring logic in `scripts/setup_db.js`.
- [ ] Implement a more robust database (e.g., SQLite or MongoDB) if the contact list grows beyond a few thousand.
- [ ] Refactor `scripts/setup_db.js` to accept Excel path via CLI arguments instead of hardcoded paths.
