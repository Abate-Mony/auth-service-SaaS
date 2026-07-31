# Environment Setup

Never commit your own `.env` file.

Only update `.env.example` when introducing a new environment variable.

---

## Development

Copy

```bash
cp .env.example .env
```

Fill in all required values.

---

## Production

The production server should use `.env.production`.

Do not commit production secrets.

---

## Required Variables

| Variable | Description |
|-----------|-------------|
| PORT | Express server port |
| MONGO_URI | MongoDB connection string |
| JWT_SECRET | JWT signing key |
| COOKIE_SECRET | Cookie signing key |
| CLIENT_URL | Frontend URL |

---

## Security

Never commit:

- Production passwords
- API Keys
- MongoDB Atlas URI
- JWT Secret
- SMTP Password
- Cloudinary Secret

---

## Git

Make sure `.gitignore` contains:

```
.env
.env.local
.env.production.local
```

Only commit

```
.env.example
```