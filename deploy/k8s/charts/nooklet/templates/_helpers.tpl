{{- define "nooklet.fullname" -}}
{{- "nooklet" }}
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
{{ .Values.image.repository }}:{{ required "image.tag is required (pin a sha-<commit> tag)" .Values.image.tag }}
{{- end }}
