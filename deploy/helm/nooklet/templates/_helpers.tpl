{{- define "nooklet.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nooklet.labels" -}}
app.kubernetes.io/name: nooklet
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "nooklet.selectorLabels" -}}
app: nooklet
release: {{ .Release.Name }}
{{- end }}

{{- define "nooklet.image" -}}
{{ .Values.image.repository }}:{{ required "image.tag is required (pin an immutable tag such as sha-<commit>)" .Values.image.tag }}
{{- end }}

{{- define "nooklet.secretName" -}}
{{- .Values.existingSecret | default (include "nooklet.fullname" .) }}
{{- end }}

{{- define "nooklet.podSecurityContext" -}}
runAsUser: 1000
runAsGroup: 1000
runAsNonRoot: true
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "nooklet.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
{{- end }}
