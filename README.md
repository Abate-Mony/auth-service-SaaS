# TimeShift

TimeShift is a modern workforce management platform designed to simplify scheduling, workforce coordination, attendance tracking, and communication between administrators, managers, and employees.

The platform allows organisations to create jobs, assign workers, monitor attendance, manage staff availability, and provide employees with a dedicated portal to manage their work.

---

## Features

### Authentication

- JWT Authentication
- Secure HTTP-only Cookies
- Refresh Token Support
- Role-based Authorization

### User Management

- Create Workers
- Manage Managers
- User Profiles
- Active / Inactive Users

### Job Management

- Create Jobs
- Edit Jobs
- Assign Multiple Workers
- Track Job Status
- Search & Filter Jobs

### Worker Portal

- View Assigned Jobs
- Clock In / Clock Out
- Calendar
- Upcoming Events
- Personal Profile

### Dashboard

- Workforce Overview
- Upcoming Jobs
- Staff Statistics
- Active Workers

### Technology

Frontend

- React
- TypeScript
- Vite
- TailwindCSS
- React Router v7
- React Hook Form
- TanStack Query
- TanStack Table
- Framer Motion

Backend

- Node.js
- Express
- MongoDB
- Mongoose
- JWT
- Zod
- bcrypt

---

# Installation

Clone the repository

```bash
git clone https://github.com/your-company/timeshift.git
```

Install dependencies

Backend

```bash
cd server
npm install
```

Frontend

```bash
cd client
npm install
```

---

# Environment Variables

Copy

```bash
cp .env.example .env
```

Fill in all required variables before starting.

---

# Development

Backend

```bash
npm run dev
```

Frontend

```bash
npm run dev
```

---

# Production Build

Frontend

```bash
npm run build
```

Backend

```bash
npm start
```

---

# Project Structure

```
client/
server/

client/src
    components/
    pages/
    hooks/
    routes/
    layouts/
    services/

server/
    controllers/
    middleware/
    models/
    routes/
    utils/
```

---

# Roles

Administrator

- Manage Everything

Manager

- Create Jobs
- Assign Workers
- Manage Workers

Worker

- View Assigned Jobs
- Clock In
- View Schedule
- Update Profile

---

# API

Authentication

```
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
```

Users

```
GET    /api/v1/users
POST   /api/v1/users/workers
PATCH  /api/v1/users/:id
DELETE /api/v1/users/:id
```

Jobs

```
GET    /api/v1/jobs
GET    /api/v1/jobs/:id
POST   /api/v1/jobs
PATCH  /api/v1/jobs/:id
DELETE /api/v1/jobs/:id
```

---

# License

Private Project

© TimeShift