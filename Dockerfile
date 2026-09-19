FROM nginx:1.27-alpine

ARG OCI_REVISION
ARG OCI_CREATED
LABEL org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.created=$OCI_CREATED

# Replace the stock :80 server with ours on :3000.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/minesweeper.conf
COPY site/ /usr/share/nginx/html/

EXPOSE 3000
