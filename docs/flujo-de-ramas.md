# Flujo de ramas

```
dev  ──(Pull Request)──▶  main
```

- **Se trabaja en `dev`.** Nada se sube directo a `main`.
- Cuando `dev` está listo se abre un Pull Request `dev → main` y se revisa.
- El backend **no** se despliega solo: tras fusionar en `main` hay que entrar al servidor y correr `./deploy/deploy.sh` (ver `docs/INFRAESTRUCTURA.md`). Las migraciones nuevas se aplican en el primer arranque posterior.

Última actualización: 2026-10-08
