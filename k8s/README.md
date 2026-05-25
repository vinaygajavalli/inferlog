# Self-hosted Kubernetes deploy

Runs the full stack (postgres, redis, ingestion, worker, web) on any cluster.
Tested against **Docker Desktop's built-in Kubernetes**, which shares your local
image store — so the images you already built with `docker compose build` are
usable directly, no registry push needed.

## One-time: enable Kubernetes
Docker Desktop → Settings → **Kubernetes** → check **Enable Kubernetes** → Apply.
Wait until the bottom-left status dot is green. Verify:
```bash
kubectl config use-context docker-desktop
kubectl get nodes        # should list one Ready node
```

## Deploy
```bash
# 1. Build the images (skip if you already ran `docker compose up --build`)
docker compose build

# 2. Apply all manifests (namespace, config, schema, postgres, redis, the 3 apps)
kubectl apply -f k8s/

# 3. Watch them come up
kubectl -n inferlog get pods -w
#   wait until all are Running / READY 1/1, then Ctrl-C
```

## Open it
The web Service is type LoadBalancer (localhost on Docker Desktop), but a
port-forward is the most reliable across clusters:
```bash
kubectl -n inferlog port-forward svc/web 3000:80
```
Then open http://localhost:3000 and http://localhost:3000/dashboard.

By default (empty Secret) the chat runs on the keyless **mock** provider, so the
deploy works with zero secrets. To use real models on k8s, put your keys in the
Secret in `01-config.yaml` (or recreate it from your .env):
```bash
kubectl -n inferlog delete secret inferlog-secrets
kubectl -n inferlog create secret generic inferlog-secrets --from-env-file=.env
kubectl -n inferlog rollout restart deploy/web
```

## Useful checks (good for screenshots)
```bash
kubectl -n inferlog get pods,svc           # everything Running
kubectl -n inferlog logs deploy/worker     # "consuming inferlog:logs"
kubectl -n inferlog logs deploy/ingestion  # POST /v1/logs 202
```

## Tear down
```bash
kubectl delete -f k8s/
```

## Notes / what I'd harden for production
- `inferlog-schema` (in `01-schema.yaml`) is **generated from `db/schema.sql`**
  so it can't drift. Regenerate after a schema change:
  ```bash
  { printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: inferlog-schema\n  namespace: inferlog\ndata:\n  schema.sql: |\n'; sed 's/^/    /' db/schema.sql; } > k8s/01-schema.yaml
  ```
  In a real cluster you'd run it via a migration `Job` / init container instead
  of Postgres initdb.
- Postgres uses an `emptyDir`; swap for a `PersistentVolumeClaim` (or managed DB).
- `ingestion` and `worker` scale horizontally (worker uses a Redis consumer
  group, so replicas split the stream without double-processing).
- Add an `Ingress` + TLS in front of `web`, and `HorizontalPodAutoscaler`s.
