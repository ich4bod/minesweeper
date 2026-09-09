FROM nginx:1.27-alpine

# Replace the stock :80 server with ours on :3000.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/minesweeper.conf
COPY site/ /usr/share/nginx/html/

EXPOSE 3000
